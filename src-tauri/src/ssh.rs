use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use russh::client;
use tokio::sync::{broadcast, mpsc, Mutex};

// ---------------------------------------------------------------------------
// SSH client handler
// ---------------------------------------------------------------------------

struct SshClientHandler {
    broadcast_tx: broadcast::Sender<Vec<u8>>,
    zmodem_active: Arc<AtomicBool>,
    zmodem_data_tx: Arc<Mutex<Option<mpsc::Sender<Vec<u8>>>>>,
}

#[async_trait]
impl client::Handler for SshClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &ssh_key::public::PublicKey,
    ) -> Result<bool, Self::Error> {
        // TODO: implement known_hosts checking
        Ok(true)
    }

    async fn data(
        &mut self,
        _channel: russh::ChannelId,
        data: &[u8],
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        // During ZMODEM mode, route data to the ZMODEM handler instead of broadcast
        if self.zmodem_active.load(Ordering::Relaxed) {
            let tx = self.zmodem_data_tx.lock().await;
            if let Some(ref zmodem_tx) = *tx {
                tracing::debug!("SSH data -> ZMODEM channel: {} bytes", data.len());
                match zmodem_tx.send(data.to_vec()).await {
                    Ok(_) => {}
                    Err(e) => {
                        tracing::error!("SSH data -> ZMODEM channel send failed: {}", e);
                    }
                }
                return Ok(());
            } else {
                tracing::warn!("SSH: zmodem_active=true but zmodem_data_tx is None, falling through to broadcast");
            }
        }
        let _ = self.broadcast_tx.send(data.to_vec());
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// SSH connection config
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, serde::Serialize, Clone, Debug)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub key_file: Option<String>,
}

// ---------------------------------------------------------------------------
// SSH connection state
// ---------------------------------------------------------------------------

pub struct SshConnection {
    pub config: SshConfig,
    pub tx_to_ssh: mpsc::Sender<Vec<u8>>,
    pub resize_tx: mpsc::Sender<(u32, u32)>,
    pub reader_handle: tokio::task::JoinHandle<()>,
    pub writer_handle: tokio::task::JoinHandle<()>,
    resize_handle: tokio::task::JoinHandle<()>,
    handle: Arc<Mutex<client::Handle<SshClientHandler>>>,
}

impl SshConnection {
    /// Try to load a private key from the given path, optionally decrypting
    /// with a passphrase.  Returns the parsed key or an error string.
    fn load_key(path: &str, passphrase: Option<&str>) -> Result<ssh_key::PrivateKey, String> {
        // Expand ~ to home directory
        let expanded = if path.starts_with("~/") {
            if let Some(home) = dirs::home_dir() {
                home.join(&path[2..]).to_string_lossy().to_string()
            } else {
                path.to_string()
            }
        } else {
            path.to_string()
        };

        let key_data = std::fs::read_to_string(&expanded)
            .map_err(|e| format!("Failed to read key file {}: {}", expanded, e))?;

        let key = ssh_key::PrivateKey::from_openssh(key_data.as_bytes())
            .or_else(|_| {
                // If the key is encrypted, try decrypting with passphrase
                if let Some(pass) = passphrase {
                    let encrypted = ssh_key::PrivateKey::from_openssh(key_data.as_bytes())
                        .map_err(|e| format!("Failed to parse key: {}", e))?;
                    encrypted
                        .decrypt(pass)
                        .map_err(|e| format!("Failed to decrypt key: {}", e))
                } else {
                    Err("Key is encrypted but no passphrase provided".to_string())
                }
            })
            .map_err(|e: String| e)?;

        Ok(key)
    }

    /// Try key-based auth, then fall back to password auth if needed.
    async fn authenticate(
        handle: &mut client::Handle<SshClientHandler>,
        config: &SshConfig,
    ) -> Result<bool, String> {
        let passphrase = config.password.as_deref();

        // Collect key file paths to try
        let mut key_paths: Vec<String> = Vec::new();
        if let Some(ref kf) = config.key_file {
            if !kf.is_empty() {
                key_paths.push(kf.clone());
            }
        }

        // If no explicit key file, try default key locations
        if key_paths.is_empty() {
            if let Some(home) = dirs::home_dir() {
                let defaults = ["id_ed25519", "id_rsa"];
                for name in &defaults {
                    let p = home.join(".ssh").join(name);
                    if p.exists() {
                        key_paths.push(p.to_string_lossy().to_string());
                    }
                }
            }
        }

        // Try key-based authentication
        for path in &key_paths {
            match Self::load_key(path, passphrase) {
                Ok(key) => {
                    let hash_alg = if key.algorithm().is_rsa() {
                        Some(ssh_key::HashAlg::Sha512)
                    } else {
                        None
                    };
                    let key_with_alg =
                        russh_keys::key::PrivateKeyWithHashAlg::new(
                            std::sync::Arc::new(key),
                            hash_alg,
                        )
                        .map_err(|e| format!("Key hash alg error: {}", e))?;

                    match handle
                        .authenticate_publickey(&config.username, key_with_alg)
                        .await
                    {
                        Ok(true) => {
                            tracing::info!("SSH key auth succeeded with {}", path);
                            return Ok(true);
                        }
                        Ok(false) => {
                            tracing::info!("SSH key auth rejected for {}", path);
                        }
                        Err(e) => {
                            tracing::warn!("SSH key auth error for {}: {}", path, e);
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("Failed to load key {}: {}", path, e);
                }
            }
        }

        // Fall back to password auth
        if let Some(ref password) = config.password {
            if !password.is_empty() {
                let result = handle
                    .authenticate_password(&config.username, password)
                    .await
                    .map_err(|e| format!("SSH auth error: {}", e))?;
                return Ok(result);
            }
        }

        // No auth method succeeded
        if key_paths.is_empty() {
            Err("No authentication method provided".to_string())
        } else {
            Ok(false)
        }
    }

    pub async fn connect(
        config: SshConfig,
        broadcast_tx: broadcast::Sender<Vec<u8>>,
        scrollback: Arc<Mutex<std::collections::VecDeque<u8>>>,
        scrollback_max: usize,
        zmodem_active: Arc<AtomicBool>,
        zmodem_data_tx: Arc<Mutex<Option<mpsc::Sender<Vec<u8>>>>>,
    ) -> Result<Self, String> {
        let ssh_config = russh::client::Config::default();

        let handler = SshClientHandler {
            broadcast_tx: broadcast_tx.clone(),
            zmodem_active,
            zmodem_data_tx,
        };

        let mut handle = tokio::time::timeout(
            Duration::from_secs(10),
            client::connect(
                Arc::new(ssh_config),
                (config.host.as_str(), config.port),
                handler,
            ),
        )
        .await
        .map_err(|_| "Connection timed out".to_string())?
        .map_err(|e| format!("SSH connection failed: {}", e))?;

        // Authenticate
        let authenticated = Self::authenticate(&mut handle, &config).await?;
        if !authenticated {
            return Err("SSH authentication failed".to_string());
        }

        // Open a session channel and request a PTY + shell
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("Failed to open SSH channel: {}", e))?;

        let channel_id = channel.id();

        channel
            .request_pty(
                false,
                "xterm-256color",
                80,
                24,
                0,
                0,
                &[],
            )
            .await
            .map_err(|e| format!("PTY request failed: {}", e))?;

        channel
            .request_shell(false)
            .await
            .map_err(|e| format!("Shell request failed: {}", e))?;

        let handle = Arc::new(Mutex::new(handle));

        // Wrap channel in Arc<Mutex<>> so resize task can call window_change
        let channel = Arc::new(Mutex::new(channel));

        // Channel for WebSocket -> SSH writer
        let (tx_to_ssh, mut rx_from_ws) = mpsc::channel::<Vec<u8>>(256);

        // Reader task: SSH data comes via the Handler's data() callback,
        // which already sends to broadcast_tx. We just need to also
        // accumulate into scrollback.
        let bc_rx_scrollback = broadcast_tx.subscribe();
        let scrollback_clone = scrollback.clone();
        let reader_handle = tokio::spawn(async move {
            let mut rx = bc_rx_scrollback;
            loop {
                match rx.recv().await {
                    Ok(data) => {
                        let mut sb = scrollback_clone.lock().await;
                        sb.extend(&data);
                        while sb.len() > scrollback_max {
                            sb.pop_front();
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                }
            }
        });

        // Writer task: WebSocket -> SSH
        let handle_for_writer = handle.clone();
        let writer_handle = tokio::spawn(async move {
            while let Some(data) = rx_from_ws.recv().await {
                let h = handle_for_writer.lock().await;
                if let Err(e) = h.data(channel_id, data.into()).await {
                    tracing::error!("SSH write error: {:?}", e);
                    break;
                }
            }
            tracing::info!("SSH writer task ended");
        });

        // Resize task: receives (cols, rows) and sends window_change via Channel
        let (resize_tx, mut resize_rx) = mpsc::channel::<(u32, u32)>(16);
        let channel_for_resize = channel.clone();
        let resize_handle = tokio::spawn(async move {
            while let Some((cols, rows)) = resize_rx.recv().await {
                let ch = channel_for_resize.lock().await;
                if let Err(e) = ch.window_change(cols, rows, 0, 0).await {
                    tracing::error!("SSH window_change error: {:?}", e);
                }
            }
            tracing::info!("SSH resize task ended");
        });

        Ok(SshConnection {
            config,
            tx_to_ssh,
            resize_tx,
            reader_handle,
            writer_handle,
            resize_handle,
            handle,
        })
    }

    pub async fn resize(&self, cols: u32, rows: u32) {
        if let Err(e) = self.resize_tx.send((cols, rows)).await {
            tracing::error!("Failed to send resize: {:?}", e);
        }
    }

    pub async fn disconnect(self) {
        self.reader_handle.abort();
        self.writer_handle.abort();
        self.resize_handle.abort();
        let h = self.handle.lock().await;
        let _ = h
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
}
