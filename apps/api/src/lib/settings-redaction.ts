/**
 * Settings redaction helpers.
 *
 * Secret-bearing settings must never be returned as raw values in API
 * responses. Instead, GET endpoints return a masked placeholder with
 * `hasValue: true` and `redacted: true`. PUT endpoints treat an empty
 * submitted value as "no change" so UIs can implement write-only fields.
 */

export const MASKED_VALUE = "••••••••";

/**
 * Returns true when the given settings key is considered secret and its
 * value must be redacted in API responses.
 *
 * A key is secret when it:
 * - starts with `credential:`, OR
 * - contains any of: secret, token, password, api_key, apikey,
 *   private_key, refresh_token, credential, webhook_secret, signing
 *   (case-insensitive substring match)
 */
export function isSecretSettingKey(key: string): boolean {
  if (key.startsWith("credential:")) return true;
  const lower = key.toLowerCase();
  return (
    lower.includes("secret") ||
    lower.includes("token") ||
    lower.includes("password") ||
    lower.includes("api_key") ||
    lower.includes("apikey") ||
    lower.includes("private_key") ||
    lower.includes("refresh_token") ||
    lower.includes("credential") ||
    lower.includes("webhook_secret") ||
    lower.includes("signing")
  );
}

export interface RedactedSetting<T extends { key: string; value: string }> {
  setting: Omit<T, "value"> & { value: string; hasValue: boolean; redacted: boolean };
}

/**
 * Returns a copy of the setting with value redacted if the key is secret.
 * Non-secret keys are returned unchanged (with `hasValue` and `redacted`
 * appended for a uniform shape).
 */
export function redactSettingValue<T extends { key: string; value: string }>(
  setting: T,
): T & { hasValue: boolean; redacted: boolean } {
  if (isSecretSettingKey(setting.key)) {
    return {
      ...setting,
      value: MASKED_VALUE,
      hasValue: setting.value !== "" && setting.value != null,
      redacted: true,
    };
  }
  return { ...setting, hasValue: true, redacted: false };
}
