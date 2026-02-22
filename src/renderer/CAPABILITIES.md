
# TALA INTERFACE - CAPABILITY MANIFEST

## A2UI Dynamic rendering
The system supports the following A2UI primitives:
- `button` (label, variant, onClick)
- `card` (title, children)
- `input` (label, placeholder)
- `text` (content)
- `container` (children)
- `html` (content: Raw HTML string) **[CRITICAL: ALLOWS SELF-MODIFICATION]**

## Self-Improvement Protocol
If the user requests a UI change, the Agent can:
1. Generate an `html` component with standard HTML5/CSS3.
2. Inject it into the A2UI stream.
3. Effectively building its own interface in real-time.
