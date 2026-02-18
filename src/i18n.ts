export type UiLanguage = 'zh' | 'en';

export const UI_LANGUAGE_KEY = 'ui_language';

export function normalizeUiLanguage(raw: string | undefined, fallback: UiLanguage = 'zh'): UiLanguage {
  if (!raw) {
    return fallback;
  }

  const lowered = raw.trim().toLowerCase();
  if (['zh', 'zh-cn', 'cn', '中文', 'chinese'].includes(lowered)) {
    return 'zh';
  }
  if (['en', 'en-us', 'english', '英文'].includes(lowered)) {
    return 'en';
  }
  return fallback;
}

export function parseLanguageInput(raw: string | undefined): UiLanguage | undefined {
  if (!raw) {
    return undefined;
  }

  const lowered = raw.trim().toLowerCase();
  if (['zh', 'zh-cn', 'cn', '中文', 'chinese'].includes(lowered)) {
    return 'zh';
  }
  if (['en', 'en-us', 'english', '英文'].includes(lowered)) {
    return 'en';
  }
  return undefined;
}

export function pickLanguageText(language: UiLanguage, zh: string, en: string): string {
  return language === 'en' ? en : zh;
}

export function languageLabel(language: UiLanguage): string {
  return language === 'en' ? 'English' : '中文';
}

export function languageInstruction(language: UiLanguage): string {
  return language === 'en'
    ? 'Language requirement: Respond in English. Keep technical terms accurate; do not switch to Chinese unless the user explicitly requests translation.'
    : '语言要求：请使用中文回复，技术术语可保留英文；除非用户明确要求翻译，否则不要切换到英文。';
}

export function withLanguageInstruction(language: UiLanguage, content: string): string {
  return `${languageInstruction(language)}\n\n${content}`;
}
