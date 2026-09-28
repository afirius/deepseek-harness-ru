/**
 * Host half of the Russian localization bundle.
 *
 * All the actual work happens in the browser half (`client.js`), which
 * registers the `ru` language and the Russian dictionaries into the locale
 * service. This half exists so the bundle has a row in the profile composition
 * and therefore a stable identity that survives client updates.
 */

/** No host service is required: the bundle only contributes browser-side copy. */
export const name = '@local/dsh-locale-ru'

/** Nothing to do on the host side; the client half owns every registration. */
export function apply() {}
