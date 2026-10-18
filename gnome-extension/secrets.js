import Secret from 'gi://Secret';

const SCHEMA = new Secret.Schema('org.gnome.shell.extensions.cliproxy-quota', Secret.SchemaFlags.NONE, {
    server: Secret.SchemaAttributeType.STRING,
});

export function lookupKey(server, cancellable = null) {
    return new Promise((resolve, reject) => {
        Secret.password_lookup(SCHEMA, {server}, cancellable, (_source, result) => {
            try {
                resolve(Secret.password_lookup_finish(result));
            } catch {
                reject(new Error('GNOME Keyring açılamadı. Anahtarlığın kilidini kontrol edin.'));
            }
        });
    });
}

export function storeKey(server, key) {
    return new Promise((resolve, reject) => {
        Secret.password_store(SCHEMA, {server}, Secret.COLLECTION_DEFAULT, `CLIProxy Quota · ${server}`, key,
            null, (_source, result) => {
                try {
                    resolve(Secret.password_store_finish(result));
                } catch {
                    reject(new Error('Yönetim anahtarı GNOME Keyring’e kaydedilemedi.'));
                }
            });
    });
}
