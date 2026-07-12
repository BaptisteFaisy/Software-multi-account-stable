//! Primitives de securite partagees entre le serveur SaaS et le pool.
//!
//! Point d'extension pour l'auth par appareil a venir (hachage de jetons,
//! tickets WebSocket a usage unique, etc.). Pour l'instant : une comparaison
//! d'egalite a temps constant pour les secrets (jetons d'admin, cles API).

/// Comparaison d'egalite a temps constant pour des secrets (jetons).
///
/// Contrairement a `==`, la boucle ne s'arrete pas au premier octet different :
/// cela empeche un attaquant de reconstituer le secret octet par octet en
/// mesurant le temps de reponse. La longueur d'un jeton n'est pas consideree
/// comme secrete : une difference de longueur renvoie immediatement `false`
/// (comportement standard, aligne sur les implementations usuelles comme
/// `subtle`/`constant_time_eq`).
pub(crate) fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::constant_time_eq;

    #[test]
    fn equal_slices_match() {
        assert!(constant_time_eq(b"secret-token", b"secret-token"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn different_content_does_not_match() {
        assert!(!constant_time_eq(b"secret-token", b"secret-tokeX"));
        assert!(!constant_time_eq(b"Xecret-token", b"secret-token"));
    }

    #[test]
    fn different_length_does_not_match() {
        assert!(!constant_time_eq(b"secret", b"secret-token"));
        assert!(!constant_time_eq(b"token", b""));
    }
}
