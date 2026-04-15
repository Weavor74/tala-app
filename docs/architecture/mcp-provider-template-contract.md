# MCP Provider Template Contract

## Purpose
Tala standardizes all MCP providers behind one typed onboarding contract so future integrations plug into authority-managed flow rather than custom per-provider wiring.

## Canonical Contracts
- Registration input: `McpProviderRegistrationInput`
- Persisted provider record: `McpProviderRecord`
- Activation request/result: `McpProviderActivationRequest`, `McpRegistrationResult.activation`
- Approved exposure contract: `McpApprovedCapabilityExposure`
- Health/classification contract: `McpServerClassification`
- Onboarding phase contract: `McpOnboardingPhaseOutcome`

## Template Kinds
- `stdio`: local process providers (`command`, `args`, `env`, `cwd`, optional startup timeout)
- `websocket`: remote websocket providers (`url`, optional timeout/protocol expectation)
- `http`: remote HTTP template contract (`baseUrl`, optional headers/health endpoint/timeout)

## Canonical Onboarding Pipeline
1. `registration_submission`
2. `registration_validation`
3. `normalization`
4. `persistence`
5. `activation_attempt`
6. `handshake_classification`
7. `capability_validation`
8. `policy_approval`
9. `capability_exposure`
10. `steady_state_health_updates`

Each phase emits stable machine-usable outcomes with reason codes. No phase is silently skipped without explicit `skipped` status.

## Authority-Only Enforcement
- Provider templates and helper builders feed `McpAuthorityService`; they do not bypass it.
- Renderer/UI cannot invent provider readiness.
- Configured providers remain non-exposed until activation + validation + policy approval succeed.
