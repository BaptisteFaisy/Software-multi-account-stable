use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

/// Garde d'ownership cross-process. Le handle ouvert conserve le verrou jusqu'a
/// son Drop (l'OS le libere aussi si le processus crashe).
pub struct ProcessFileLock {
    _file: fs::File,
}

pub fn try_process_lock(path: &Path) -> io::Result<ProcessFileLock> {
    use fs2::FileExt;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(path)?;
    file.try_lock_exclusive()?;
    Ok(ProcessFileLock { _file: file })
}

/// Ecrit un fichier via un temporaire sibling unique, puis remplace la cible.
///
/// Le nom contient le PID et un UUID : plusieurs processus CST partageant le
/// meme repertoire ne peuvent donc plus s'ecraser mutuellement leurs
/// `*.cst-tmp`. Le temporaire est cree avec `create_new` et nettoye sur erreur.
pub fn atomic_write(path: &Path, contents: impl AsRef<[u8]>) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let temp = unique_temp_path(path);
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)?;
        file.write_all(contents.as_ref())?;
        file.sync_all()?;
        drop(file);
        replace_file(&temp, path)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// Variante streaming pour les transcripts potentiellement volumineux.
pub fn atomic_copy(source: &Path, target: &Path) -> io::Result<u64> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = unique_temp_path(target);
    let result = (|| {
        let mut input = fs::File::open(source)?;
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)?;
        let copied = io::copy(&mut input, &mut output)?;
        output.flush()?;
        output.sync_all()?;
        drop(output);
        replace_file(&temp, target)?;
        Ok(copied)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn unique_temp_path(path: &Path) -> PathBuf {
    let mut name = OsString::from(".");
    name.push(
        path.file_name()
            .unwrap_or_else(|| std::ffi::OsStr::new("cst-file")),
    );
    name.push(format!(
        ".cst-tmp-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    path.with_file_name(name)
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
    fs::rename(source, target)
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: les deux buffers sont termines par NUL et restent vivants pendant
    // l'appel. MoveFileExW assure le remplacement atomique sur le meme volume.
    let ok = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("cst-atomic-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");

        atomic_write(&path, b"one").unwrap();
        atomic_write(&path, b"two").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "two");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        let _ = fs::remove_dir_all(dir);
    }
}
