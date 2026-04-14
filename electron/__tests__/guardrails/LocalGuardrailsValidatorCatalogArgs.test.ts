import { applyLocalGuardrailsCatalogDefaults } from '../../../shared/guardrails/localGuardrailsValidatorCatalog';

describe('Local guardrails catalog arg safety', () => {
    it('applies defaults for missing args', () => {
        const args = applyLocalGuardrailsCatalogDefaults('ToxicLanguage', {});
        expect(args.threshold).toBe(0.5);
    });

    it('preserves valid typed values', () => {
        const args = applyLocalGuardrailsCatalogDefaults('ToxicLanguage', { threshold: 0.8 });
        expect(args.threshold).toBe(0.8);
    });

    it('normalizes and clamps typed values', () => {
        const toxicArgs = applyLocalGuardrailsCatalogDefaults('ToxicLanguage', { threshold: 9 });
        expect(toxicArgs.threshold).toBe(1);

        const piiArgs = applyLocalGuardrailsCatalogDefaults('DetectPII', { pii_entities: 'EMAIL_ADDRESS, PHONE_NUMBER' });
        expect(piiArgs.pii_entities).toEqual(['EMAIL_ADDRESS', 'PHONE_NUMBER']);
    });

    it('passes through args for unknown validator names', () => {
        const raw = { alpha: 1, enabled: true };
        const args = applyLocalGuardrailsCatalogDefaults('CustomValidator', raw);
        expect(args).toEqual(raw);
    });
});

