import sanitizeHtml from 'sanitize-html';

const previewAllowedTags = [
    'a', 'abbr', 'article', 'aside', 'b', 'blockquote', 'br', 'caption', 'code', 'div',
    'em', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
    'hr', 'i', 'img', 'kbd', 'li', 'main', 'mark', 'ol', 'p', 'pre', 's', 'section', 'small',
    'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul'
];

const previewAllowedAttributes: Record<string, string[]> = {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    '*': ['class', 'style'],
};

const previewSanitizeOptions: sanitizeHtml.IOptions = {
    allowedTags: previewAllowedTags,
    allowedAttributes: previewAllowedAttributes,
    allowedSchemes: ['http', 'https', 'file', 'blob', 'data'],
    allowedSchemesByTag: {
        a: ['http', 'https', 'file'],
        img: ['http', 'https', 'file', 'blob', 'data'],
    },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    parseStyleAttributes: true,
    transformTags: {
        a: (_tagName: string, attrs: Record<string, string>) => ({
            tagName: 'a',
            attribs: {
                ...attrs,
                target: '_blank',
                rel: 'noopener noreferrer',
            }
        }),
        img: (_tagName: string, attrs: Record<string, string>) => {
            const rawSrc = (attrs.src || '').trim().toLowerCase();
            const isSvgDataUri = rawSrc.startsWith('data:image/svg+xml');
            if (!attrs.src || isSvgDataUri) {
                return {
                    tagName: 'span',
                    attribs: {},
                    text: '[blocked image source]',
                };
            }
            return {
                tagName: 'img',
                attribs: attrs,
            };
        }
    },
    exclusiveFilter: (frame: sanitizeHtml.IFrame) => {
        if (frame.tag === 'a') {
            const href = (frame.attribs.href || '').trim().toLowerCase();
            if (href.startsWith('javascript:') || href.startsWith('vbscript:') || href.startsWith('data:text/html')) {
                return true;
            }
        }
        return false;
    },
};

export function buildSanitizedWorkspacePreviewHtml(input: string): string {
    return sanitizeHtml(input || '', previewSanitizeOptions);
}
