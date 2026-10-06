import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// SVG connector overlay adapted from documd-visuals, Editorial theme.
const ink = '#2b2620', line = '#8a7f6d';
const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export const text = (x,y,s,size=19,anchor='middle') => `<text x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}" fill="${ink}">${esc(s)}</text>`;
export const box = (x,y,w,h,labels,kind='neutral') => {
  const [fill,stroke] = {neutral:['#f5f0e4',line],accent:['#d8dee0','#295279'],failure:['#eed9d3','#943b37'],success:['#dee3d6','#466b48']}[kind];
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}" stroke="${stroke}"/>`+labels.map((s,i)=>text(x+w/2,y+h/2+6+(i-(labels.length-1)/2)*25,s)).join('');
};
export const arrow = (d,dashed=false) => `<path d="${d}" fill="none" stroke="${line}" stroke-width="1.5" ${dashed?'stroke-dasharray="5 5"':''} marker-end="url(#arrow)"/>`;
export function save(name,title,desc,height,content){
  if(content.includes('undefined')) throw new Error(name);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="780" height="${height}" viewBox="0 0 780 ${height}" role="img" aria-labelledby="title desc"><title id="title">${esc(title)}</title><desc id="desc">${esc(desc)}</desc><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 Z" fill="${line}"/></marker></defs><rect width="780" height="${height}" fill="#fdfaf3"/>${text(24,34,title,22,'start')}${content}</svg>\n`;
  writeFileSync(fileURLToPath(new URL(`../../public/images/posts/${name}.svg`,import.meta.url)),svg);
  console.log(name);
}
