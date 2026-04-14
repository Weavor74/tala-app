class SmokeValidationResult:
    def __init__(self, passed: bool, error_message: str | None = None, fixed_value: str | None = None):
        self.passed = passed
        self.error_message = error_message
        self.fixed_value = fixed_value


class SmokeContainsWord:
    """Packaged local smoke validator used for runtime trust checks.

    This is intentionally deterministic and offline-safe.
    """

    def __init__(self, blocked_word: str = 'forbidden'):
        self.blocked_word = (blocked_word or 'forbidden').lower()

    def validate(self, value, _metadata=None):
        text = str(value or '')
        if self.blocked_word in text.lower():
            return SmokeValidationResult(
                passed=False,
                error_message=f"blocked word '{self.blocked_word}' detected",
                fixed_value=text.replace(self.blocked_word, '[blocked]'),
            )
        return SmokeValidationResult(passed=True)
