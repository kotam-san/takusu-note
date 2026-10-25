// はじめて使うときに聞く、本人のこと（プロフィール）。
// 画面・中継・Claude Code 版のどれからも使えるよう、画面に依存しない形で置く。
// 会社名や人の名前は聞かない。自由記述は、幹部の役職と「その他」の業種の短い1行だけで、あとは選ぶだけ。
// 社長には役職を聞かず、部下の数の代わりに従業員数を聞く（2026-10-25 作者が試して）。

export const PROFILE_FIELDS = {
  employees: {
    label: "従業員数",
    options: [
      { value: "1-5", label: "1〜5人" },
      { value: "6-20", label: "6〜20人" },
      { value: "21-50", label: "21〜50人" },
      { value: "51-100", label: "51〜100人" },
      { value: "101+", label: "101人以上" },
    ],
  },
  reports: {
    label: "直属の部下の数",
    options: [
      { value: "0", label: "0人" },
      { value: "1-3", label: "1〜3人" },
      { value: "4-10", label: "4〜10人" },
      { value: "11+", label: "11人以上" },
    ],
  },
  years: {
    label: { ceo: "社長になってからの年数", leader: "リーダー以上の立場の経験年数" },
    options: [
      { value: "<1", label: "1年未満" },
      { value: "1-3", label: "1〜3年" },
      { value: "3-10", label: "3〜10年" },
      { value: "10+", label: "10年以上" },
    ],
  },
  industry: {
    label: "業種",
    options: [
      { value: "mfg", label: "製造" },
      { value: "construction", label: "建設" },
      { value: "retail", label: "小売・飲食" },
      { value: "wholesale", label: "卸・商社" },
      { value: "service", label: "サービス" },
      { value: "care", label: "医療・福祉" },
      { value: "other", label: "その他" },
    ],
  },
};

// 立場ごとに選んでもらう項目（並び順は画面の順）
export const ROLE_FIELDS = {
  ceo: ["employees", "years", "industry"],
  leader: ["reports", "years", "industry"],
};

export const TITLE_MAX = 20; // 幹部の役職
export const INDUSTRY_OTHER_MAX = 20; // 業種で「その他」を選んだときの記入
const ROLE_NAME = { ceo: "社長", leader: "幹部" };

const labelOf = (field, value) => PROFILE_FIELDS[field].options.find((o) => o.value === value)?.label;
const shortText = (v, max) => (v ?? "") === "" || (typeof v === "string" && v.length <= max);

// 形と範囲が正しければ整えた写しを、そうでなければ null を返す。
// role を渡さないとき（記録の読み込み）は、どちらかの立場の形になっていれば通す。
export function validateProfile(p, role) {
  if (!p || typeof p !== "object") return null;
  if (!role) return validateProfile(p, "ceo") ?? validateProfile(p, "leader");
  if (!ROLE_FIELDS[role]) return null;
  if (!shortText(p.title, TITLE_MAX) || !shortText(p.industry_other, INDUSTRY_OTHER_MAX)) return null;
  const out = {};
  for (const k of ROLE_FIELDS[role]) {
    if (!labelOf(k, p[k])) return null;
    out[k] = p[k];
  }
  if (role === "leader") out.title = (p.title ?? "").trim();
  out.industry_other = p.industry === "other" ? (p.industry_other ?? "").trim() : "";
  return out;
}

// AI に渡す1行。例：「社長・従業員21〜50人・社長になってからの年数1〜3年・業種は製造」
//                  「幹部・工場長・直属の部下4〜10人・リーダー以上の立場の経験年数1〜3年・業種はその他（印刷）」
export function profileText(p, role) {
  const industry = p.industry === "other" && p.industry_other ? `その他（${p.industry_other}）` : labelOf("industry", p.industry);
  return [
    ROLE_NAME[role],
    role === "leader" ? p.title || null : null,
    role === "ceo" ? `従業員${labelOf("employees", p.employees)}` : `直属の部下${labelOf("reports", p.reports)}`,
    `${PROFILE_FIELDS.years.label[role]}${labelOf("years", p.years)}`,
    `業種は${industry}`,
  ].filter(Boolean).join("・");
}
