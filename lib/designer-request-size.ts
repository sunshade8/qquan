/**
 * Tokens an image block costs the input. Official formula (platform.claude.com vision guide): ⌈width/28⌉ × ⌈height/28⌉ visual tokens, so a
 * 1,420 × 456 chart is 51 × 17 = 867 (the stage-4 ETH run's 24-chart turn: 22,194 cache-write tokens = 24 × 867 + about 1.4k of text).
 * The reservation keeps 1,100: about 27% above the real cost, and a smaller reservation would only matter near the budget cap.
 * Limits checked against the same guide: 100 images per request on 200k-context models (600 otherwise); above 20 images every image must stay
 * within 2,000 px per side (ours 1,420); 32 MB per request.
 */
export const DESIGNER_IMAGE_TOKENS = 1100;
/**
 * The request's size as the estimators see it: JSON length with base64 image data replaced by the
 * characters an image's tokens would occupy (3 per token), so a screenful of chart PNGs is not
 * mistaken for hundreds of thousands of tokens of text.
 */
export function designerRequestChars(value: unknown) {
  let images = 0;
  const json = JSON.stringify(value, (key, item) => {
    if (key === "data" && typeof item === "string" && item.length > 2000) {
      images++;
      return "";
    }
    return item;
  });
  return json.length + images * DESIGNER_IMAGE_TOKENS * 3;
}
