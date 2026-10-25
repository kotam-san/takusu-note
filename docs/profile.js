// はじめて使うときに聞く、本人のこと（プロフィール）。
// 画面・中継・Claude Code 版のどれからも使えるよう、画面に依存しない形で置く。
// 会社名や人の名前は聞かない。役職だけ短い自由記述で、あとは選ぶだけ。

export const PROFILE_FIELDS = {
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

export const TITLE_MAX = 20;
const CHOICE_KEYS = ["reports", "years", "industry"];
const ROLE_NAME = { ceo: "社長", leader: "幹部" };

const labelOf = (field, value) => PROFILE_FIELDS[field].options.find((o) => o.value === value)?.label;

// 形と範囲が正しければ整えた写しを、そうでなければ null を返す
export function validateProfile(p) {
  if (!p || typeof p !== "object") return null;
  const title = p.title ?? "";
  if (typeof title !== "string" || title.length > TITLE_MAX) return null;
  for (const k of CHOICE_KEYS) if (!labelOf(k, p[k])) return null;
  return { title: title.trim(), reports: p.reports, years: p.years, industry: p.industry };
}

// AI に渡す1行。例：「幹部・工場長・直属の部下4〜10人・リーダー以上の立場の経験年数1〜3年・業種は製造」
export function profileText(p, role) {
  const years = PROFILE_FIELDS.years.label[role];
  return [
    ROLE_NAME[role],
    p.title || null,
    `直属の部下${labelOf("reports", p.reports)}`,
    `${years}${labelOf("years", p.years)}`,
    `業種は${labelOf("industry", p.industry)}`,
  ].filter(Boolean).join("・");
}
