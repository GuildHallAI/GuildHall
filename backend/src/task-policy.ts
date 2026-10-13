import { z } from "zod";
import { ApiError } from "./http.js";

export const taskSafetyAttestation = z.literal(true);
const restrictedActivity = [
  /\b(?:illegal(?:ly)?|unlawful(?:ly)?|weapons?|firearms?|explosives?|drugs?|drug\s+trafficking|trespass(?:ing)?|steal(?:ing)?|theft|break(?:ing)?\s+into)\b/i,
  /\b(?:underage|minors?|children|child|kids?|teens?|teenagers?|infants?|toddlers?|bab(?:y|ies)|juveniles?|schoolchildren|daycare|babysit(?:ting)?)\b/i,
  /\b(?:stalk(?:ing|er|ers)?|surveil(?:lance|ling)?|harass(?:ment|ing)?|bully(?:ing)?|intimidat(?:e|es|ed|ing|ion)|threaten(?:s|ed|ing)?|doxx?(?:ing)?|swatting)\b/i,
  /\b(?:spy|spying|tail|tailing)\s+(?:on\s+)?(?:a person|people|someone|an individual|my ex|my partner|employees?|customers?|users?)\b/i,
  /\b(?:track(?:ing)?|follow(?:ing)?|monitor(?:ing)?|watch(?:ing)?|locat(?:e|ing)|identify|film(?:ing)?|record(?:ing)?|photograph(?:ing)?)\s+(?:a person|people|someone|an individual|my ex|my partner|employees?|customers?|users?)\b/i,
  /\b(?:private|home|residential)\s+(?:home\s+)?addresses?\b/i,
  /\bpersonal\s+(?:data|information|info|details|identifiable\s+information)\b/i,
  /\bthird[ -]party\s+(?:personal|private|sensitive)\s+(?:data|information|info)\b/i,
  /\b(?:collect|gather|record|capture|scrape|harvest|compile|sell|buy)\s+(?:someone'?s|people'?s|a person'?s|users?'?|customers?'?|employees?'?)\s+(?:personal|private|contact|identifying|sensitive)?\s*(?:data|information|info|details|names|addresses|phone numbers|email addresses|profiles)\b/i,
  /\b(?:contact\s+details|phone\s+numbers?|email\s+addresses?|social\s+security\s+numbers?|license\s+plates?|biometric\s+(?:data|information)|personally\s+identifiable\s+information|\bpii\b)\b/i,
];

export function assertSafeTaskText(title: string, description: string) {
  const normalizedText = `${title}\n${description}`.normalize("NFKC").replace(/[\p{Cf}]/gu, "");
  if (restrictedActivity.some((pattern) => pattern.test(normalizedText))) {
    throw new ApiError(400, "restricted_task", "GuildHall cannot accept tasks involving illegal or unsafe activity, minors, harassment, surveillance of people, or collection of third-party personal data.");
  }
}
