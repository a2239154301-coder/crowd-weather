/** 予報モデルの型。LLMは一切関与しない決定的な計算層。 */

export type Weather = "sunny" | "cloudy" | "rainy";

/** 開催日。太陽位置（影・日射）の計算に使う */
export type EventDate = { y: number; mo: number; d: number; label: string };

/**
 * 会場の場所。実況の取得先であり、**太陽位置の計算にも効く**
 * （緯度が変わると南中高度が変わる＝同じ建物でも影の長さが変わる）。
 */
export type VenueGeo = { name: string; lat: number; lon: number };

/**
 * 主催者が動かす予報条件。
 * 2026-08-11 馬場v4の暑熱エンジン統合で RH・風速・開催日 を追加
 * （WBGTを物理計算にしたため湿球・黒球の入力が要る）。
 */
export type Scenario = {
  weather: Weather;
  /** 予想最高気温（℃） */
  temp: number;
  /** チケット販売数＝来場規模の最重要変数 */
  tickets: number;
  /** 相対湿度（%）。WBGTの湿球温度に効く */
  rhPct: number;
  /** 風速（m/s）。自然湿球・黒球の対流冷却に効く */
  windMs: number;
  /** 開催日。太陽位置を実計算する */
  date: EventDate;
  /** 会場の場所。実況取得と太陽位置の両方に使う */
  geo: VenueGeo;
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
  /**
   * 実際に人が待つ帯の面積（m²）。日よけテント必要数の分母（馬場v4から導入）。
   * 未設定のゾーンはテント提案の対象外
   */
  queueArea?: number;
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
  /**
   * 日よけテントの推奨（馬場v4のテント配置提案を統合）。
   * from/to は分（例 750 = 12:30）。queueArea を持つゾーンだけが対象
   */
  tents: {
    total: number;
    list: { zoneId: string; zoneName: string; need: number; from: number; to: number }[];
  };
};
