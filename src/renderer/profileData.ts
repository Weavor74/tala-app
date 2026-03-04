import type { FullUserProfilePII } from '../../electron/services/userProfileTypes';

export type { Address, Job, School, Contact } from '../../electron/services/userProfileTypes';

/**
 * The complete user profile data model.
 * Aligned with FullUserProfilePII from the main process.
 */
export interface UserDeepProfile extends FullUserProfilePII { }

/**
 * Empty default profile used when no saved profile is found on disk.
 * Pre-populates all fields to avoid null-reference errors in the UI.
 */
export const DEFAULT_PROFILE: UserDeepProfile = {
    userId: '',
    firstName: '',
    middleName: '',
    lastName: '',
    dateOfBirth: '',
    placeOfBirth: '',
    rpName: '',
    address: { street: '', unit: '', city: '', state: '', zip: '', country: '' },
    email: '',
    phone: '',
    workHistory: [],
    schools: [],
    hobbies: [],
    network: [],
    schemaVersion: 1,
    lastUpdated: new Date().toISOString()
};
