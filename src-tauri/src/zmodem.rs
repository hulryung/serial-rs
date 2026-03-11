use std::io::Write;
use std::path::PathBuf;

// ZMODEM start sequence: **\x18B0 (ZRQINIT from sender)
const ZMODEM_INIT: &[u8] = b"**\x18B0";

/// Scan a buffer for the ZMODEM init sequence.
pub fn detect_zmodem(buf: &[u8]) -> bool {
    if buf.len() < ZMODEM_INIT.len() {
        return false;
    }
    buf.windows(ZMODEM_INIT.len())
        .any(|w| w == ZMODEM_INIT)
}

/// ZMODEM receiver wrapping the `zmodem2` crate.
/// Provides a simple `process()` / `is_done()` API for the interceptor task.
pub struct ZmodemReceiver {
    inner: zmodem2::Receiver,
    download_dir: PathBuf,
    received_files: Vec<PathBuf>,
    current_file: Option<std::fs::File>,
    current_filename: Option<String>,
    current_file_size: u64,
    bytes_received: u64,
    done: bool,
}

impl ZmodemReceiver {
    pub fn new(download_dir: PathBuf) -> Self {
        ZmodemReceiver {
            inner: zmodem2::Receiver::new().expect("Failed to create ZMODEM receiver"),
            download_dir,
            received_files: Vec::new(),
            current_file: None,
            current_filename: None,
            current_file_size: 0,
            bytes_received: 0,
            done: false,
        }
    }

    /// Feed incoming serial/SSH data and return response bytes to send back.
    pub fn process(&mut self, incoming: &[u8]) -> Vec<u8> {
        let mut response = Vec::new();

        // Drain any pending outgoing data first (e.g. ZRINIT queued by constructor)
        self.drain_outgoing_to(&mut response);

        // Feed incoming data
        let mut offset = 0;
        while offset < incoming.len() {
            match self.inner.feed_incoming(&incoming[offset..]) {
                Ok(consumed) => {
                    if consumed == 0 {
                        // feed_incoming returns 0 when outgoing/file buffers need
                        // draining before more data can be accepted. Drain and retry.
                        self.process_events();
                        self.write_file_data();
                        self.drain_outgoing_to(&mut response);

                        match self.inner.feed_incoming(&incoming[offset..]) {
                            Ok(0) | Err(_) => break,
                            Ok(c) => {
                                offset += c;
                            }
                        }
                    } else {
                        offset += consumed;
                    }
                }
                Err(e) => {
                    tracing::error!("ZMODEM feed error: {:?}", e);
                    self.done = true;
                    break;
                }
            }

            self.process_events();
            self.write_file_data();
            self.drain_outgoing_to(&mut response);
        }

        // Final drain
        self.process_events();
        self.write_file_data();
        self.drain_outgoing_to(&mut response);

        response
    }

    fn drain_outgoing_to(&mut self, response: &mut Vec<u8>) {
        let outgoing = self.inner.drain_outgoing();
        if !outgoing.is_empty() {
            response.extend_from_slice(outgoing);
            let len = outgoing.len();
            self.inner.advance_outgoing(len);
        }
    }

    fn process_events(&mut self) {
        while let Some(event) = self.inner.poll_event() {
            match event {
                zmodem2::ReceiverEvent::FileStart => {
                    let filename = String::from_utf8_lossy(self.inner.file_name()).to_string();
                    // Sanitize: take only basename
                    let filename = std::path::Path::new(&filename)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| {
                            format!("zmodem_recv_{}", self.received_files.len())
                        });

                    self.current_file_size = self.inner.file_size() as u64;
                    self.bytes_received = 0;
                    tracing::info!("ZMODEM: receiving file: {} ({} bytes)", filename, self.current_file_size);

                    let file_path = self.download_dir.join(&filename);
                    match std::fs::File::create(&file_path) {
                        Ok(f) => {
                            self.current_file = Some(f);
                            self.current_filename = Some(filename);
                        }
                        Err(e) => {
                            tracing::error!("ZMODEM: failed to create file: {}", e);
                        }
                    }
                }
                zmodem2::ReceiverEvent::FileComplete => {
                    if let Some(file) = self.current_file.take() {
                        drop(file);
                        if let Some(filename) = self.current_filename.take() {
                            let path = self.download_dir.join(&filename);
                            tracing::info!("ZMODEM: file received: {}", path.display());
                            self.received_files.push(path);
                        }
                    }
                }
                zmodem2::ReceiverEvent::SessionComplete => {
                    tracing::info!("ZMODEM: session complete");
                    self.done = true;
                }
            }
        }
    }

    fn write_file_data(&mut self) {
        let file_data = self.inner.drain_file();
        if !file_data.is_empty() {
            let len = file_data.len();
            self.bytes_received += len as u64;
            if let Some(ref mut file) = self.current_file {
                if let Err(e) = file.write_all(file_data) {
                    tracing::error!("ZMODEM: file write error: {}", e);
                }
            }
            let _ = self.inner.advance_file(len);
        }
    }

    pub fn is_done(&self) -> bool {
        self.done
    }

    pub fn received_files(&self) -> &[PathBuf] {
        &self.received_files
    }

    pub fn current_filename(&self) -> Option<&str> {
        self.current_filename.as_deref()
    }

    pub fn current_file_size(&self) -> u64 {
        self.current_file_size
    }

    pub fn bytes_received(&self) -> u64 {
        self.bytes_received
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_zmodem() {
        assert!(detect_zmodem(b"**\x18B0"));
        assert!(detect_zmodem(b"hello**\x18B0world"));
        assert!(!detect_zmodem(b"hello world"));
        assert!(!detect_zmodem(b"**\x18B"));
        assert!(!detect_zmodem(b""));
    }

    #[test]
    fn test_receiver_creation() {
        let recv = ZmodemReceiver::new(PathBuf::from("/tmp"));
        assert!(!recv.is_done());
        assert!(recv.received_files().is_empty());
    }
}
