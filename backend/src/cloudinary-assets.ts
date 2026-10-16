import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { v2 as cloudinary } from "cloudinary";
import { config } from "./config.js";
import { ApiError } from "./http.js";

export const MAX_COMMISSION_IMAGE_BYTES = 10 * 1024 * 1024;
const allowedImageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

type CloudinaryImage = {
  public_id: string;
  format: string;
  bytes: number;
  width: number;
  height: number;
};

function configureCloudinary() {
  if (!config.CLOUDINARY_CLOUD_NAME || !config.CLOUDINARY_API_KEY || !config.CLOUDINARY_API_SECRET) {
    throw new ApiError(503, "image_storage_unavailable", "Image delivery is not configured.");
  }
  cloudinary.config({
    cloud_name: config.CLOUDINARY_CLOUD_NAME,
    api_key: config.CLOUDINARY_API_KEY,
    api_secret: config.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

export function validateCommissionImage(bytes: Buffer, contentType: string) {
  if (!allowedImageTypes.has(contentType)) {
    throw new ApiError(415, "unsupported_image_type", "Use a PNG, JPEG, or WebP image.");
  }
  if (!bytes.length || bytes.length > MAX_COMMISSION_IMAGE_BYTES) {
    throw new ApiError(413, "image_size_limit", "Images must be between 1 byte and 10 MiB.");
  }
  const validSignature = contentType === "image/png"
    ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : contentType === "image/jpeg"
      ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!validSignature) throw new ApiError(415, "invalid_image_data", "The file contents do not match the selected image type.");
}

export async function uploadCommissionImage(commissionId: string, bytes: Buffer, contentType: string): Promise<CloudinaryImage> {
  configureCloudinary();
  validateCommissionImage(bytes, contentType);
  const publicId = `guildhall/commission-submissions/${commissionId}/${randomUUID()}`;
  return new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream({
      resource_type: "image",
      type: "authenticated",
      public_id: publicId,
      overwrite: false,
      unique_filename: false,
      use_filename: false,
      tags: ["guildhall", "commission-submission"],
    }, (error, result) => {
      if (error) reject(new ApiError(502, "image_upload_failed", "Cloudinary could not store the generated image."));
      else if (!result) reject(new ApiError(502, "image_upload_failed", "Cloudinary returned no image metadata."));
      else resolve(result as CloudinaryImage);
    });
    Readable.from([bytes]).pipe(upload);
  });
}

export async function readCommissionImage(publicId: string, format: string) {
  configureCloudinary();
  const url = cloudinary.utils.private_download_url(publicId, format, {
    resource_type: "image",
    type: "authenticated",
    expires_at: Math.floor(Date.now() / 1000) + 120,
    attachment: false,
  });
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
  if (!response.ok) throw new ApiError(502, "image_download_failed", "Cloudinary could not retrieve the commission image.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_COMMISSION_IMAGE_BYTES) {
    throw new ApiError(502, "image_download_invalid", "The stored commission image has an invalid size.");
  }
  return bytes;
}

export async function deleteCommissionImage(publicId: string) {
  configureCloudinary();
  await cloudinary.uploader.destroy(publicId, { resource_type: "image", type: "authenticated", invalidate: true });
}
