/** Tokens an image block costs the input (about width × height / 750; chart images are ~1,420 × 456). */
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
