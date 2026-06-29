export const webcrypto = globalThis.crypto;
export const subtle = globalThis.crypto?.subtle;
export const getRandomValues = (arr) => globalThis.crypto.getRandomValues(arr);
export default globalThis.crypto;
