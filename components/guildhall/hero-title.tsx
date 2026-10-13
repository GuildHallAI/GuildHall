"use client";

const desktop=[[-12.4034,394.4444,7.752126,5.555556],[172.2673,487.0423,7.752126,6.957746],[349.9611,440,7.752126,6.285714],[433.8542,398,7.752126,5.685714],[577.4386,435,7.752126,6.214286],[757.4581,340,7.752126,4.857143],[949.8809,390,7.752126,5.571429],[1136.8773,438,7.752126,6.257143],[1280.4617,355,7.752126,5.071429]];
const mobile=[[-6.025,128.1944,3.765643,1.805556],[79.9363,136.0563,3.765643,1.943662],[162.5085,125,3.765643,1.785714],[199.5165,132,3.765643,1.885714],[265.5199,130,3.765643,1.857143],[-7.8853,308,4.380704,2.285714],[95.6806,299,4.380704,2.157143],[196.1799,312,4.380704,2.342857],[272.1473,304,4.380704,2.228571]];
const transform=([x,y,sx,sy]:number[])=>`translate(${x} ${y}) scale(${sx} ${sy})`;
// Fixed glyph bounds reserve the complete title before hydration and font loading.
export function HeroTitle(){
  return <h1 className="hero-wordmark" data-ready="true" aria-label="GuildHall">
    <svg className="hero-title-desktop" viewBox="0 0 1420 500" aria-hidden="true">
      {'GUILDHALL'.split('').map((letter,i)=><text key={i} transform={transform(desktop[i])} data-row="0" data-height={[400,494,440,398,435,340,390,438,355][i]}>{letter}</text>)}
    </svg>
    <svg className="hero-title-mobile" viewBox="0 0 351 312" preserveAspectRatio="none" aria-hidden="true">
      {'GUILDHALL'.split('').map((letter,i)=><text key={i} transform={transform(mobile[i])} data-row={i<5?0:1} data-height={[130,138,125,132,130,160,151,164,156][i]}>{letter}</text>)}
    </svg>
  </h1>;
}
