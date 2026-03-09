/**
 * User Profile Editor
 *
 * A high-confidentiality interface for managing the user's "Deep Profile".
 * This data acts as the ground truth for TALA's identity system and PII handling.
 * 
 * **Content Domains:**
 * - **Identity**: Legal names, birth data, and RP (Roleplay) aliases.
 * - **Residence**: Physical address and contact vectors.
 * - **History**: Professional employment and educational background.
 * - **Social Network**: Trusted contacts and relational context.
 * 
 * **Security Context:**
 * - Writes to `user_profile.json` via the encrypted `saveProfile` IPC handler.
 * - This component is protected by strict PII leakage guards at the service layer.
 */
import { useState, useEffect } from 'react';
import { DEFAULT_PROFILE } from './profileData';
import type { UserDeepProfile } from './profileData';

/**
 * Labeled Form Field
 * 
 * Unified input component for the profile editor.
 * 
 * @param {Object} props
 * @param {string} props.label Visual label for the input.
 * @param {string} props.value Current state values.
 * @param {Function} props.onChange React state setter callback.
 * @param {string} [props.placeholder] Optional input hint.
 * @param {string} [props.width] Optional CSS width override.
 */
const Field = ({ label, value, onChange, placeholder, width = '100%' }: any) => (
    <div style={{ marginBottom: 12, width }}>
        <label style={labelStyle}>{label}</label>
        <input
            style={inputStyle}
            value={value || ''}
            onChange={onChange}
            placeholder={placeholder}
        />
    </div>
);

// Reusable Section Header
const SectionTitle = ({ title }: { title: string }) => (
    <div style={{
        borderBottom: '1px solid #454545',
        paddingBottom: 8,
        marginTop: 30,
        marginBottom: 20,
        color: '#007acc',
        fontWeight: 'bold',
        letterSpacing: 1,
        fontSize: 12
    }}>
        {title.toUpperCase()}
    </div>
);

export const UserProfile = () => {
    const [data, setData] = useState<UserDeepProfile>(DEFAULT_PROFILE);
    const [status, setStatus] = useState<string>('');

    // Load Data
    useEffect(() => {
        const load = async () => {
            const api = (window as any).tala;
            if (api) {
                const loaded = await api.getProfile();
                if (loaded) {
                    // Merge with default to ensure all fields exist (if migration needed)
                    setData({ ...DEFAULT_PROFILE, ...loaded });
                }
            }
        };
        load();
    }, []);

    // Save Data
    const handleSave = async () => {
        setStatus('Saving Record...');
        const api = (window as any).tala;
        if (api) {
            await api.saveProfile(data);
            setStatus('Record Updated Successfully.');
            setTimeout(() => setStatus(''), 3000);
        }
    };

    // Generic Change Handler for top-level keys
    const set = (key: keyof UserDeepProfile, value: any) => setData(prev => ({ ...prev, [key]: value }));
    const setAddress = (key: string, val: string) => setData(prev => ({ ...prev, address: { ...prev.address, [key]: val } }));

    // List Management Helpers
    const addAuth = () => setData(prev => ({ ...prev, workHistory: [...prev.workHistory, { company: '', role: '', startDate: '', endDate: '', description: '' }] }));
    const addSchool = () => setData(prev => ({ ...prev, schools: [...prev.schools, { institution: '', degree: '', yearGraduated: '' }] }));
    const addContact = () => setData(prev => ({ ...prev, network: [...prev.network, { name: '', relation: '', contactInfo: '', notes: '' }] }));

    const updateItem = (listKey: 'workHistory' | 'schools' | 'network', index: number, field: string, val: string) => {
        setData(prev => {
            const list = [...prev[listKey]] as any[];
            list[index] = { ...list[index], [field]: val };
            return { ...prev, [listKey]: list };
        });
    };

    const removeItem = (listKey: 'workHistory' | 'schools' | 'network', index: number) => {
        setData(prev => ({ ...prev, [listKey]: (prev[listKey] as any[]).filter((_, i) => i !== index) }));
    };

    return (
        <div className="profile-container" style={{ padding: '40px', maxWidth: '800px', margin: '0 auto', color: '#ccc', paddingBottom: 100 }}>
            <h1 style={{ borderBottom: '1px solid #333', paddingBottom: '10px', color: '#fff' }}>FULL PII RECORD</h1>
            <p style={{ fontSize: '12px', opacity: 0.7, marginBottom: '30px' }}>
                CONFIDENTIAL: This record constitutes the ground truth for the User Identity.
            </p>

            {/* IDENTITY SECTION */}
            <SectionTitle title="Identity" />
            <div style={{ display: 'flex', gap: 20 }}>
                <Field label="First Name" value={data.firstName} onChange={(e: any) => set('firstName', e.target.value)} />
                <Field label="Middle Name" value={data.middleName} onChange={(e: any) => set('middleName', e.target.value)} />
                <Field label="Last Name" value={data.lastName} onChange={(e: any) => set('lastName', e.target.value)} />
            </div>
            <div style={{ display: 'flex', gap: 20 }}>
                <Field label="Date of Birth" value={data.dateOfBirth} onChange={(e: any) => set('dateOfBirth', e.target.value)} placeholder="YYYY-MM-DD" />
                <Field label="Place of Birth" value={data.placeOfBirth} onChange={(e: any) => set('placeOfBirth', e.target.value)} />
            </div>
            <Field label="RP / Character Name (for in-universe interactions)" value={data.rpName} onChange={(e: any) => set('rpName', e.target.value)} placeholder="e.g., Kael, Raven, etc." />

            {/* CONTACT SECTION */}
            <SectionTitle title="Contact & Residence" />
            <Field label="Street Address" value={data.address.street} onChange={(e: any) => setAddress('street', e.target.value)} />
            <div style={{ display: 'flex', gap: 20 }}>
                <Field label="Unit/Apt" width="100px" value={data.address.unit} onChange={(e: any) => setAddress('unit', e.target.value)} />
                <Field label="City" value={data.address.city} onChange={(e: any) => setAddress('city', e.target.value)} />
                <Field label="State/Prov" width="100px" value={data.address.state} onChange={(e: any) => setAddress('state', e.target.value)} />
                <Field label="Zip" width="100px" value={data.address.zip} onChange={(e: any) => setAddress('zip', e.target.value)} />
            </div>
            <Field label="Country" value={data.address.country} onChange={(e: any) => setAddress('country', e.target.value)} />
            <div style={{ display: 'flex', gap: 20 }}>
                <Field label="Direct Email" value={data.email} onChange={(e: any) => set('email', e.target.value)} />
                <Field label="Phone #1" value={data.phone} onChange={(e: any) => set('phone', e.target.value)} />
            </div>

            {/* EMPLOYMENT SECTION */}
            <SectionTitle title="Employment History" />
            {data.workHistory.map((job, i) => (
                <div key={i} style={cardStyle}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <h4 style={{ margin: '0 0 10px 0', color: '#dcdcaa' }}>Position #{i + 1}</h4>
                        <button onClick={() => removeItem('workHistory', i)} style={removeBtn}>Remove</button>
                    </div>
                    <div style={{ display: 'flex', gap: 20 }}>
                        <Field label="Company" value={job.company} onChange={(e: any) => updateItem('workHistory', i, 'company', e.target.value)} />
                        <Field label="Role Title" value={job.role} onChange={(e: any) => updateItem('workHistory', i, 'role', e.target.value)} />
                    </div>
                    <div style={{ display: 'flex', gap: 20 }}>
                        <Field label="Start Date" value={job.startDate} onChange={(e: any) => updateItem('workHistory', i, 'startDate', e.target.value)} placeholder="YYYY-MM" />
                        <Field label="End Date" value={job.endDate} onChange={(e: any) => updateItem('workHistory', i, 'endDate', e.target.value)} placeholder="YYYY-MM or Present" />
                    </div>
                    <Field label="Description / Duties" value={job.description} onChange={(e: any) => updateItem('workHistory', i, 'description', e.target.value)} />
                </div>
            ))}
            <button onClick={addAuth} style={addBtn}>+ Add Employment Record</button>

            {/* EDUCATION SECTION */}
            <SectionTitle title="Education" />
            {data.schools.map((school, i) => (
                <div key={i} style={cardStyle}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', gap: 20, flex: 1 }}>
                            <Field label="Institution" value={school.institution} onChange={(e: any) => updateItem('schools', i, 'institution', e.target.value)} />
                            <Field label="Degree / Cert" value={school.degree} onChange={(e: any) => updateItem('schools', i, 'degree', e.target.value)} />
                            <Field label="Year" width="80px" value={school.yearGraduated} onChange={(e: any) => updateItem('schools', i, 'yearGraduated', e.target.value)} />
                        </div>
                        <button onClick={() => removeItem('schools', i)} style={{ ...removeBtn, height: 24, marginLeft: 10 }}>×</button>
                    </div>
                </div>
            ))}
            <button onClick={addSchool} style={addBtn}>+ Add Education Info</button>

            {/* SOCIAL SECTION */}
            <SectionTitle title="Friends, Family & Contacts" />
            {data.network.map((person, i) => (
                <div key={i} style={cardStyle}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <h4 style={{ margin: '0 0 10px 0', color: '#dcdcaa' }}>Contact #{i + 1}</h4>
                        <button onClick={() => removeItem('network', i)} style={removeBtn}>Remove</button>
                    </div>
                    <div style={{ display: 'flex', gap: 20 }}>
                        <Field label="Full Name" value={person.name} onChange={(e: any) => updateItem('network', i, 'name', e.target.value)} />
                        <Field label="Relation (e.g. Brother, Friend)" value={person.relation} onChange={(e: any) => updateItem('network', i, 'relation', e.target.value)} />
                    </div>
                    <Field label="Contact Info (Phone/Email)" value={person.contactInfo} onChange={(e: any) => updateItem('network', i, 'contactInfo', e.target.value)} />
                    <Field label="Notes" value={person.notes} onChange={(e: any) => updateItem('network', i, 'notes', e.target.value)} />
                </div>
            ))}
            <button onClick={addContact} style={addBtn}>+ Add Contact</button>

            {/* HOBBIES SECTION */}
            <SectionTitle title="Hobbies & Interests" />
            <p style={{ fontSize: 11, color: '#888' }}>Enter hobbies as a comma-separated list.</p>
            <textarea
                style={{ ...inputStyle, height: 60 }}
                value={data.hobbies.join(', ')}
                onChange={(e) => set('hobbies', e.target.value.split(',').map(s => s.trim()))}
                placeholder="Photography, Hiking, Retro Computing..."
            />

            {/* SAVE ACTION */}
            <div style={{ marginTop: 50, borderTop: '1px solid #333', paddingTop: 20 }}>
                <button onClick={handleSave} style={primaryBtn}>
                    SAVE FULL PROFILE
                </button>
                {status && <span style={{ marginLeft: 15, color: '#4ec9b0', fontSize: 13, fontWeight: 'bold' }}>{status}</span>}
            </div>
        </div>
    );
};

// Styles
const labelStyle = { display: 'block', fontSize: '11px', fontWeight: 'bold', color: '#569cd6', marginBottom: '6px', letterSpacing: '0.5px' };
const inputStyle = { width: '100%', background: '#252526', border: '1px solid #3e3e42', padding: '8px 10px', color: 'white', fontFamily: 'Segoe UI', fontSize: '13px', outline: 'none' };
const cardStyle = { background: '#2d2d2d', padding: 15, borderRadius: 4, marginBottom: 15, border: '1px solid #3e3e42' };

const primaryBtn = { background: '#007acc', color: 'white', border: 'none', padding: '12px 32px', fontSize: '14px', cursor: 'pointer', fontWeight: 'bold', borderRadius: 2 };
const addBtn = { background: 'transparent', color: '#007acc', border: '1px dashed #007acc', padding: '8px 16px', fontSize: '12px', cursor: 'pointer', borderRadius: 2, marginBottom: 10, width: '100%' };
const removeBtn = { background: 'transparent', color: '#f14c4c', border: 'none', cursor: 'pointer', fontSize: '11px', textDecoration: 'underline' };
