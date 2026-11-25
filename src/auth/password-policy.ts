import * as v from 'valibot';

/**
 * What a new password must be: typed by an admin as a temporary password, or chosen by the person.
 * 8–200 characters with at least one letter and one digit. Length matters more than character classes (NIST
 * SP 800-63B); the letter + digit rule only stops "12345678" and "password".
 */
export const newPasswordSchema = v.pipe(
    v.string(),
    v.minLength(8, 'Use at least 8 characters'),
    v.maxLength(200, 'Use at most 200 characters'),
    v.regex(/\p{L}/u, 'Include at least one letter'),
    v.regex(/\d/, 'Include at least one digit')
);
