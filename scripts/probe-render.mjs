/**
 * probe-ingest の結果が「地図として成立しているか」を目で確かめるためのスクリプト。
 * 読み取ったゾーンを元画像の上に重ねたSVGを書き出す。
 *
 *   node scripts/probe-render.mjs
 *
 * 座標が範囲内で面積が十分でも、写真の実際の位置とズレていたら意味がない。
 * 数値チェックだけでは分からないので、必ず絵で確認する。
 */
import { readFileSync, writeFileSync } from "node:fs";

const W = 1000;
const H = 700;

const KIND_COLOR = {
  stage: "#E5254A",
  indoor: "#A78BFA",
  gate: "#FB7A1E",
  corridor: "#38BDF8",
  queue: "#FDE047",
  aid: "#22C55E",
  station: "#7DD3FC",
  alley: "#F472B6",
};

const venue = JSON.parse(readFileSync(new URL("../.probe-venue.json", import.meta.url), "utf8"));
const b64 = readFileSync(new URL("../public/samples/venue-sample-1024.png", import.meta.url)).toString("base64");

const path = (poly) =>
  poly.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ") + "Z";
const centroid = (poly) => ({
  x: poly.reduce((a, p) => a + p.x, 0) / poly.length,
  y: poly.reduce((a, p) => a + p.y, 0) / poly.length,
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <image href="data:image/png;base64,${b64}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>
  <rect x="0" y="0" width="${W}" height="${H}" fill="#0A0E17" opacity="0.35"/>
  ${(venue.buildings ?? [])
    .map(
      (b) => `<path d="${path(b.shape)}" fill="#0D1420" fill-opacity="0.5" stroke="#93A3C0" stroke-width="1.5" stroke-dasharray="5 3"/>
  <text x="${centroid(b.shape).x}" y="${centroid(b.shape).y}" text-anchor="middle" font-size="11" fill="#93A3C0">${b.name} ${b.height}m</text>`
    )
    .join("\n  ")}
  ${(venue.zones ?? [])
    .map((z) => {
      const c = centroid(z.shape);
      const col = KIND_COLOR[z.kind] ?? "#fff";
      return `<path d="${path(z.shape)}" fill="${col}" fill-opacity="0.28" stroke="${col}" stroke-width="2"/>
  <text x="${c.x}" y="${c.y - 4}" text-anchor="middle" font-size="14" font-weight="600" fill="#fff">${z.name}</text>
  <text x="${c.x}" y="${c.y + 13}" text-anchor="middle" font-size="11" fill="${col}">${z.kind}${z.roofed ? "・屋根" : ""}</text>`;
    })
    .join("\n  ")}
</svg>`;

writeFileSync(new URL("../.probe-overlay.svg", import.meta.url), svg);
console.log("書き出し: .probe-overlay.svg");
console.log(`ゾーン ${venue.zones?.length} 件 / 構造物 ${venue.buildings?.length} 件`);
