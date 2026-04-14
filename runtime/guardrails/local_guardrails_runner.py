#!/usr/bin/env python3
"""Local Guardrails runner for Tala.

Contract:
- Input: JSON from stdin, or a JSON file path passed as argv[1]
- Output: single JSON object to stdout
- Never write non-JSON content to stdout
"""

from __future__ import annotations

import importlib
import json
import sys
import traceback
from typing import Any, Dict, Optional, Tuple


def _emit(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def _fail(code: str, message: str, err_type: Optional[str] = None, details: Optional[Dict[str, Any]] = None) -> None:
    error_payload: Dict[str, Any] = {
        "ok": False,
        "error": {
            "code": code,
            "message": message,
        },
    }
    if err_type:
        error_payload["error"]["type"] = err_type
    if details:
        error_payload["error"]["details"] = details
    _emit(error_payload)


def _read_payload() -> Dict[str, Any]:
    if len(sys.argv) > 1:
        with open(sys.argv[1], "r", encoding="utf-8") as f:
            return json.load(f)

    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("input payload is empty")
    return json.loads(raw)


def _load_validator_class(validator_name: str):
    hub_error: Optional[Exception] = None
    try:
        from guardrails import hub  # type: ignore

        candidate = getattr(hub, validator_name, None)
        if candidate is not None:
            return candidate
    except Exception as err:  # pragma: no cover - dependent on env
        hub_error = err

    if "." in validator_name:
        module_name, class_name = validator_name.rsplit(".", 1)
        module = importlib.import_module(module_name)
        candidate = getattr(module, class_name, None)
        if candidate is None:
            raise AttributeError(f"class '{class_name}' not found in module '{module_name}'")
        return candidate

    if hub_error:
        raise RuntimeError(
            "Failed to load validator from guardrails.hub. "
            "Provide a dotted module path (e.g. package.module.Validator) if not in hub."
        ) from hub_error

    raise LookupError(
        f"Validator '{validator_name}' not found in guardrails.hub and no dotted module path was provided"
    )


def _extract_result(raw_result: Any) -> Tuple[bool, Optional[str], Optional[str], Optional[str]]:
    class_name = raw_result.__class__.__name__ if raw_result is not None else "Unknown"

    passed_value = getattr(raw_result, "passed", None)
    if isinstance(passed_value, bool):
        passed = passed_value
    else:
        outcome = getattr(raw_result, "outcome", None)
        if isinstance(outcome, str):
            lowered = outcome.strip().lower()
            if lowered in ("pass", "passed", "ok", "success"):
                passed = True
            elif lowered in ("fail", "failed", "error", "deny"):
                passed = False
            else:
                passed = class_name == "PassResult"
        else:
            passed = class_name == "PassResult"

    error_message = None
    for attr in ("error_message", "message", "error"):
        value = getattr(raw_result, attr, None)
        if isinstance(value, str) and value.strip():
            error_message = value
            break

    fixed_value = None
    for attr in ("fixed_value", "fix_value", "value"):
        value = getattr(raw_result, attr, None)
        if isinstance(value, str):
            fixed_value = value
            break

    output = None
    for attr in ("output", "validated_output", "value"):
        value = getattr(raw_result, attr, None)
        if isinstance(value, str):
            output = value
            break

    return passed, output, error_message, fixed_value


def main() -> int:
    try:
        payload = _read_payload()

        validator_name = payload.get("validator_name")
        if not isinstance(validator_name, str) or not validator_name.strip():
            _fail("INVALID_PAYLOAD", "validator_name must be a non-empty string", "ValueError")
            return 0

        validator_args = payload.get("validator_args", {})
        if not isinstance(validator_args, dict):
            _fail("INVALID_PAYLOAD", "validator_args must be an object", "ValueError")
            return 0

        content = payload.get("content")
        if not isinstance(content, str):
            _fail("INVALID_PAYLOAD", "content must be a string", "ValueError")
            return 0

        validator_class = _load_validator_class(validator_name)
        validator = validator_class(**validator_args)

        validate_fn = getattr(validator, "validate", None)
        if validate_fn is None or not callable(validate_fn):
            _fail(
                "VALIDATOR_INVALID",
                f"Validator '{validator_name}' does not expose a callable validate method",
                "AttributeError",
            )
            return 0

        try:
            raw_result = validate_fn(content, {})
        except TypeError:
            raw_result = validate_fn(content)

        passed, output, error_message, fixed_value = _extract_result(raw_result)

        _emit(
            {
                "ok": True,
                "result": {
                    "passed": passed,
                    "output": output,
                    "error_message": error_message,
                    "fixed_value": fixed_value,
                    "validator_name": validator_name,
                },
            }
        )
        return 0

    except json.JSONDecodeError as err:
        _fail("INVALID_JSON", f"Failed to parse JSON payload: {err.msg}", err.__class__.__name__)
        return 0
    except ModuleNotFoundError as err:
        _fail(
            "DEPENDENCY_MISSING",
            f"Missing Python module dependency: {err.name}",
            err.__class__.__name__,
        )
        return 0
    except Exception as err:  # pragma: no cover - safety net
        _fail(
            "RUNNER_ERROR",
            str(err),
            err.__class__.__name__,
            details={"traceback": traceback.format_exc(limit=8)},
        )
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
