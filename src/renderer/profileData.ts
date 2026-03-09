/**
 * User Profile State & Defaults
 * 
 * This file manages the frontend's view of the "Deep Profile".
 * It acts as a bridge to the backend PII types and provides a safe default state.
 */
import type { FullUserProfilePII } from '../../electron/services/userProfileTypes';

export type { Address, Job, School, Contact } from '../../electron/services/userProfileTypes';

/**
 * Deep Profile Schema
 * 
 * Extends the backend `FullUserProfilePII` to ensure strict typing 
 * in the renderer application.
 */
export interface UserDeepProfile extends FullUserProfilePII { }

/**
 * Global Profile Default
 * 
 * Used for new installations or when the profile record is corrupted/missing.
 * Ensures consistent object structure for React rendering.
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
