export function buildDisplayFileUrl(value?: string): string {
    if (!value) return '';
    if (/^(https?:|data:|blob:|file:)/i.test(value)) return value;
    const normalized = value.replace(/\\/g, '/');
    return encodeURI(`file:///${normalized.replace(/^\/+/, '')}`);
}

export function checkAllowedImageSource(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) return false;
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('javascript:') || lower.startsWith('vbscript:')) return false;
    if (lower.startsWith('data:')) {
        const header = lower.slice(5, lower.indexOf(',') > -1 ? lower.indexOf(',') : undefined);
        if (!header.startsWith('image/')) return false;
        if (header.startsWith('image/svg+xml')) return false;
        return true;
    }

    try {
        const parsed = new URL(trimmed);
        const protocol = parsed.protocol.toLowerCase();
        return protocol === 'file:' || protocol === 'http:' || protocol === 'https:' || protocol === 'blob:';
    } catch {
        // Treat unqualified values as local filesystem paths.
        return true;
    }
}

export function convertTextToEscapedHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function normalizeSafeHtmlPreview(input: string): string {
    let safe = input || '';
    safe = safe.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
    safe = safe.replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '');
    safe = safe.replace(/<link[\s\S]*?>/gi, '');
    safe = safe.replace(/<meta[\s\S]*?>/gi, '');
    safe = safe.replace(/<base[\s\S]*?>/gi, '');
    safe = safe.replace(/<object[\s\S]*?>[\s\S]*?<\/object>/gi, '');
    safe = safe.replace(/<embed[\s\S]*?>/gi, '');
    safe = safe.replace(/<frame[\s\S]*?>[\s\S]*?<\/frame>/gi, '');
    safe = safe.replace(/<frameset[\s\S]*?>[\s\S]*?<\/frameset>/gi, '');
    safe = safe.replace(/<form[\s\S]*?>[\s\S]*?<\/form>/gi, '');
    safe = safe.replace(/\son\w+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, '');
    safe = safe.replace(/(href|src)\s*=\s*(['"])\s*(javascript|vbscript|data:text\/html):[^'"]*\2/gi, '$1="#"');
    safe = safe.replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, '');
    return safe;
}

export function buildSandboxedPreviewDocument(innerHtml: string): string {
    return [
        '<!DOCTYPE html>',
        '<html><head>',
        "<meta charset=\"utf-8\">",
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: blob: file:; style-src 'unsafe-inline';\">",
        '</head><body style="margin:0;padding:0;word-break:break-word;">',
        innerHtml,
        '</body></html>'
    ].join('');
}

/**
 * Minimal preview conversion for RTF -> HTML.
 * Supports basic paragraphs plus bold/italic/underline markers.
 */
export function convertRtfToPreviewHtml(rtf: string): string {
    if (!rtf) return '<p></p>';
    let text = rtf;
    text = text.replace(/\\par[d]?/g, '\n');
    text = text.replace(/\\line/g, '\n');
    text = text.replace(/\\tab/g, '\t');

    text = text.replace(/\\b\s([^\\{}]+)/g, '[[B_START]]$1[[B_END]]');
    text = text.replace(/\\i\s([^\\{}]+)/g, '[[I_START]]$1[[I_END]]');
    text = text.replace(/\\ul\s([^\\{}]+)/g, '[[U_START]]$1[[U_END]]');

    text = text.replace(/\\'[0-9a-fA-F]{2}/g, '');
    text = text.replace(/\\[a-zA-Z]+\d*\s?/g, '');
    text = text.replace(/[{}]/g, '');

    const lines = text
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => {
            let safeLine = convertTextToEscapedHtml(l);
            safeLine = safeLine
                .replace(/\[\[B_START\]\]/g, '<strong>')
                .replace(/\[\[B_END\]\]/g, '</strong>')
                .replace(/\[\[I_START\]\]/g, '<em>')
                .replace(/\[\[I_END\]\]/g, '</em>')
                .replace(/\[\[U_START\]\]/g, '<u>')
                .replace(/\[\[U_END\]\]/g, '</u>');
            return `<p>${safeLine}</p>`;
        });

    if (lines.length === 0) {
        return '<p></p>';
    }
    return lines.join('');
}
