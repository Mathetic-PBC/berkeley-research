"use strict";
// Evaluation only. Do not truncate or rewrite production output to satisfy a
// word count, or constrain legitimate verbs with a production word whitelist.
const STYLE_CRITERIA = [
  "Every label begins with an active verb in context, not a noun, passive capability, or UI component. Judge grammar, not membership in a list of approved verbs.",
  "Labels describe the student's or researcher's accomplishment, not a UI component being built. Each could plausibly be a researcher's notebook goal for tomorrow.",
  "Each description is one direct, concise sentence about what the person can see, do, test, compare, or understand. It does not read like a product specification or enumerate UI components unless the control itself is essential to the research question.",
  "Each why is one short sentence explaining why this foothold comes next, without repeating its description.",
  "The three subgoals preserve orient, demonstrate, manipulate on the same concrete example whenever possible, without automatically expanding to more examples or cohort-wide analysis."
];
const words = value => String(value || "").trim().split(/\s+/u).filter(Boolean).length;
const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const sentences = value => [...segmenter.segment(String(value || ""))].filter(s => s.segment.trim()).length;
// These are review flags, not grammar judgments. The semantic judge decides
// whether a flagged UI phrase is essential to this particular research task.
const productPhrasing = /\b(?:(?:a|the)\s+(?:panel displays|interface allows|window shows|ranked list appears|system provides)|checkboxes let|users can)\b/i;
function styleMeasurements(subgoals) {
  return subgoals.map(g => ({
    labelWords: words(g.label), descriptionWords: words(g.description), whyWords: words(g.why),
    descriptionSentences: sentences(g.description), whySentences: sentences(g.why),
    productPhrasing: productPhrasing.test(g.description),
  }));
}
function withinStyleTargets(m) {
  return m.labelWords >= 3 && m.labelWords <= 8 &&
    m.descriptionWords >= 15 && m.descriptionWords <= 30 &&
    m.whyWords >= 10 && m.whyWords <= 25 &&
    m.descriptionSentences === 1 && m.whySentences === 1;
}
module.exports = { STYLE_CRITERIA, styleMeasurements, withinStyleTargets };
