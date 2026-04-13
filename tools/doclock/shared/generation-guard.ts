import * as path from 'node:path';
import { loadContract } from './io';
import { resolveArtifactClassification, validateArtifactName } from './artifact-naming';
import {
  ArtifactClassification,
  ArtifactClassificationInput,
  ArtifactNameValidationResult,
  NamingContract
} from './types';

const ROOT = path.resolve(__dirname, '../../..');
const CONTRACT_PATH = path.join(ROOT, 'docs/contracts/naming.contract.json');

let cachedContract: NamingContract | null = null;

export function getNamingContract(): NamingContract {
  if (!cachedContract) {
    cachedContract = loadContract(CONTRACT_PATH);
  }
  return cachedContract;
}

export function resolveArtifactClassificationOrThrow(input: ArtifactClassificationInput): ArtifactClassification {
  const contract = getNamingContract();
  const result = resolveArtifactClassification(input, contract);
  if (!result.ok) {
    throw new Error(`Invalid artifact classification: ${result.errors.join('; ')}`);
  }
  return result.classification;
}

export function validateArtifactNameOrThrow(
  classification: ArtifactClassification,
  proposedName: string
): ArtifactNameValidationResult {
  const contract = getNamingContract();
  const validation = validateArtifactName(contract, classification, proposedName);
  if (!validation.valid) {
    const errorMessages = validation.issues
      .filter(issue => issue.severity === 'error')
      .map(issue => `${issue.rule}: ${issue.message}`)
      .join(' | ');

    throw new Error(`Artifact naming validation failed for \"${proposedName}\": ${errorMessages}`);
  }
  return validation;
}

export function validateArtifactPreWriteOrThrow(input: {
  classification: ArtifactClassificationInput;
  name: string;
}): ArtifactNameValidationResult {
  const classification = resolveArtifactClassificationOrThrow(input.classification);
  return validateArtifactNameOrThrow(classification, input.name);
}
