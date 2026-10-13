// Ink wetness, diffusion, deckled edges and spatter adapted from the user-supplied Ink Brush scene.
export const inkVertex=`attribute vec2 aPosition;varying vec2 vUv;void main(){vUv=aPosition*.5+.5;gl_Position=vec4(aPosition,0.,1.);}`;
export const inkUpdate=`
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uPrev;
        uniform vec2 uResolution, uP0, uP1;
        uniform float uActive, uSpeed, uRadius, uDeposit, uSmear, uDecay, uDiffuse, uClick, uTime;
        uniform vec3 uDrops[24];
        uniform int uDropCount;
        
  float hash21(vec2 p){ p = fract(p * vec2(123.34, 345.45)); p += dot(p, p + 34.345); return fract(p.x * p.y); }
  float vnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    float a = hash21(i), b = hash21(i + vec2(1.,0.)), c = hash21(i + vec2(0.,1.)), d = hash21(i + vec2(1.,1.));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * vnoise(p); p *= 2.02; a *= 0.5; } return s; }
  float sdSeg(vec2 p, vec2 a, vec2 b){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0); return length(pa - ba * h); }

        void main(){
          vec2 uv = vUv;
          vec2 texel = 1.0 / uResolution;

          // --- diffuse (ink bleed) then decay (drying / it is temporary) ---
          float c = texture2D(uPrev, uv).r;
          float n = texture2D(uPrev, uv + vec2(0.0, texel.y)).r;
          float s = texture2D(uPrev, uv - vec2(0.0, texel.y)).r;
          float e = texture2D(uPrev, uv + vec2(texel.x, 0.0)).r;
          float w = texture2D(uPrev, uv - vec2(texel.x, 0.0)).r;
          float blur = (n + s + e + w) * 0.25;
          float val = mix(c, blur, clamp(uDiffuse, 0.0, 1.0));
          val *= uDecay;

          // Drying pixels need only the five texture samples above.
          if (uActive < 0.5 && uDropCount == 0) {
            gl_FragColor = vec4(clamp(val, 0.0, 1.0), 0.0, 0.0, 1.0);
            return;
          }

          // --- deposit fresh ink along the pointer segment (aspect-correct) ---
          float aspect = uResolution.x / uResolution.y;
          vec2 p = vec2(uv.x * aspect, uv.y);
          vec2 a = vec2(uP0.x * aspect, uP0.y);
          vec2 b = vec2(uP1.x * aspect, uP1.y);
          float d = sdSeg(p, a, b);

          // organic wobble on the stamp radius so the blot never reads as a clean disc
          if (uActive > 0.5 && d < uRadius * 1.42 * (1.0 + uClick * 1.4)) {
          float ang = atan(p.y - b.y, p.x - b.x);
          float wob = fbm(vec2(ang * 1.6 + 3.0, uTime * 0.6));
          float r = uRadius * (0.72 + 0.7 * wob) * (1.0 + uClick * 1.4);

          float amount = uDeposit * (0.55 + uSmear * uSpeed) + uClick;
          float stamp = smoothstep(r, r * 0.15, d) * amount * uActive;
          val += stamp;
          }

          // --- spatter: discrete round droplets spawned CPU-side, flung off the stroke ---
          for (int i = 0; i < 24; i++) {
            if (i >= uDropCount) break;
            vec3 dp = uDrops[i];
            vec2 dpos = vec2(dp.x * aspect, dp.y);
            float dr = max(dp.z, 1e-4);
            float ds = 1.0 - smoothstep(dr * 0.45, dr, length(p - dpos));
            val = max(val, ds);                       // solid round dot; max so overlaps don't blow out
          }

          gl_FragColor = vec4(clamp(val, 0.0, 1.0), 0.0, 0.0, 1.0);
        }`;
export const inkDisplay=`precision highp float;
varying vec2 vUv;
uniform sampler2D uTrail;
uniform vec2 uResolution;
uniform float uTime;

  float hash21(vec2 p){ p = fract(p * vec2(123.34, 345.45)); p += dot(p, p + 34.345); return fract(p.x * p.y); }
  float vnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    float a = hash21(i), b = hash21(i + vec2(1.,0.)), c = hash21(i + vec2(0.,1.)), d = hash21(i + vec2(1.,1.));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * vnoise(p); p *= 2.02; a *= 0.5; } return s; }
  float sdSeg(vec2 p, vec2 a, vec2 b){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0); return length(pa - ba * h); }

void main(){
 float t=texture2D(uTrail,vUv).r;
 if(t<0.018){gl_FragColor=vec4(0.0);return;}
 vec2 sp=vec2(vUv.x*uResolution.x/uResolution.y,vUv.y);
 float edge=fbm(sp*16.0+11.0)*0.65+fbm(sp*33.0+4.0)*0.35;
 float mott=fbm(sp*23.0+t*3.0+uTime*0.05);
 float ink=smoothstep(0.30,0.52,t+(edge-0.5)*0.18);
 float wet=smoothstep(0.03,0.42,t)*(1.0-ink);
 vec3 col=mix(vec3(0.77,0.60,0.27),vec3(0.95,0.92,0.85),ink)+(mott-0.5)*0.035;
 gl_FragColor=vec4(col,ink*0.42+wet*0.12);
}`;
