/** 予報モデルの型。LLMは一切関与しない決定的な計算層。 */

export type Weather = "sunny" | "cloudy" | "rainy";

/** 主催者が動かす3つの変数。これだけで一日の予報が決まる。 */
export type Scenario = {
  weather: Weather;
  /** 予想最高気温（℃） */
  temp: number;
  /** チケット販売数＝来場規模の最重要変数 */
  tickets: number;
};

export type ZoneKind =
  | "stage" // 観客が滞留する
  | "indoor" // 雨で人が集まる／屋根あり
  | "gate" // 開場・終演で詰まる
  | "corridor" // 通り抜ける
  | "queue" // 並ぶ
  | "aid" // 救護・給水
  | "station" // 駅ホーム・コンコース
  | "alley"; // 路地

export type Point = { x: number; y: number };

export type Zone = {
  id: string;
  name: string;
  kind: ZoneKind;
  /** そのゾーン固有の混みやすさ係数 */
  base: number;
  /** 実際の形。会場図の上に描く多角形（viewBox座標） */
  shape: Point[];
  /** 屋根の下にあるか（建物の影とは別に、常時日陰） */
  roofed?: boolean;
  /** ラベルを置く位置。省略時は重心 */
  label?: Point;
};

/** 影を落とす構造物。日陰予報の入力。 */
export type Building = {
  id: string;
  name: string;
  /** 平面の footprint（矩形とは限らない） */
  shape: Point[];
  /** 高さ。影の長さを決める */
  height: number;
};

/** 会場。優先01（会場資料の読解）が最終的に生成するのはこの型。 */
export type Venue = {
  id: string;
  name: string;
  /** SVGの座標系 */
  width: number;
  height: number;
  /** 開場・終演（時） */
  open: number;
  close: number;
  zones: Zone[];
  buildings: Building[];
  /** 地面の下地（芝・舗装・水面など）。装飾ではなく会場図の読みやすさのため */
  ground: { id: string; kind: "grass" | "paved" | "water" | "deck"; shape: Point[] }[];
};

export type Severity = 0 | 1 | 2 | 3;

/** ある時刻・あるゾーンの予報値 */
export type ZoneForecast = {
  zone: Zone;
  /** 混雑指数 0-100 */
  density: number;
  /** 暑さ指数 WBGT（℃） */
  wbgt: number;
  /**
   * そのゾーンのうち日陰になっている面積の割合 0-1。
   * 重心1点の二値判定だと「半分だけ影」が数字に出ず、時間で動かないため面積比で持つ。
   */
  shadeFraction: number;
  /** 表示用。面積の半分以上が日陰か */
  shaded: boolean;
};

/** 一日分の要約と、そこから決まる打ち手 */
export type DayPlan = {
  peakDensity: number;
  peakDensityHour: number;
  peakDensityZone: Zone;
  peakWbgt: number;
  peakWbgtHour: number;
  peakWbgtZone: Zone;
  waitMin: number;
  /** 推奨する増員・運用変更 */
  water: number;
  aid: number;
  guide: number;
  mist: boolean;
  oneway: boolean;
  entryControl: boolean;
  stationCoord: boolean;
  corridorDanger: boolean;
  outsideDanger: boolean;
  /** 人時試算 */
  baselinePersonHours: number;
  optimizedPersonHours: number;
  savedPercent: number;
};
