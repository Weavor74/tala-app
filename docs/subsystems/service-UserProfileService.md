# Service: UserProfileService.ts

**Source**: [electron\services\UserProfileService.ts](../../electron/services/UserProfileService.ts)

## Class: `UserProfileService`

## Overview
UserProfileService  Single source of truth for user PII and profile data. Manages persistence, identity context generation, and redaction.

### Methods

#### `ensureProfileDir`
**Arguments**: `userDataPath: string`

---
#### `load`
Loads the profile from disk./

**Arguments**: ``

---
#### `ensureValidProfile`
Ensures we have a profile with a valid UUID./

**Arguments**: ``

---
#### `save`
Persists the profile to disk./

**Arguments**: `profile: FullUserProfilePII`
**Returns**: `void`

---
#### `getFullProfile`
Returns the full profile (sensitive)./

**Arguments**: ``
**Returns**: `FullUserProfilePII | null`

---
#### `getIdentityContext`
Returns a minimal identity context safe for prompts. Guaranteed to return a valid UUID for the user./

**Arguments**: ``
**Returns**: `UserIdentityContext`

---
