use std::collections::HashSet;
use std::mem::size_of;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;

#[cfg(windows)]
mod win_impl {
    use super::*;
    use std::ffi::c_void;
    use windows::core::{implement, IUnknown, Interface, HRESULT};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
    use windows::Win32::Media::Audio::{
        eCommunications, eConsole, eRender, ActivateAudioInterfaceAsync,
        IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler,
        IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
        IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator,
        AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
        AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
        AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        WAVEFORMATEX, WAVE_FORMAT_PCM,
    };
    use windows::Win32::System::Com::StructuredStorage::{
        PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, BLOB, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        CreateEventW, GetCurrentProcessId, SetEvent, WaitForSingleObject,
    };
    use windows::Win32::System::Variant::VT_BLOB;

    struct HandleGuard(isize);
    impl Drop for HandleGuard {
        fn drop(&mut self) {
            unsafe {
                let h = HANDLE(self.0 as *mut c_void);
                if !h.is_invalid() {
                    let _ = CloseHandle(h);
                }
            }
        }
    }

    #[implement(IActivateAudioInterfaceCompletionHandler)]
    struct CompletionHandler {
        event: Arc<HandleGuard>,
    }

    impl IActivateAudioInterfaceCompletionHandler_Impl for CompletionHandler_Impl {
        fn ActivateCompleted(
            &self,
            _activateoperation: windows::core::Ref<'_, IActivateAudioInterfaceAsyncOperation>,
        ) -> windows::core::Result<()> {
            unsafe {
                let _ = SetEvent(HANDLE(self.event.0 as *mut c_void));
            }
            Ok(())
        }
    }

    struct ComGuard;
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    /// Descobre o PID exato do subprocesso WebView2 (AudioService ou Browser) que pertence ao PeerBuddy.
    /// Passar esse PID ao WASAPI Process Loopback exclui a voz do colega reproduzida pelo WebView2.
    pub unsafe fn find_target_audio_pid(root_pid: u32) -> u32 {
        let mut descendants = HashSet::new();
        descendants.insert(root_pid);
        let mut direct_webview_child: Option<u32> = None;

        if let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            let _snap_guard = HandleGuard(snap.0 as isize);
            let mut entries: Vec<(u32, u32)> = Vec::new();
            let mut pe = PROCESSENTRY32W {
                dwSize: size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };

            if Process32FirstW(snap, &mut pe).is_ok() {
                loop {
                    entries.push((pe.th32ProcessID, pe.th32ParentProcessID));
                    if pe.th32ParentProcessID == root_pid && direct_webview_child.is_none() {
                        direct_webview_child = Some(pe.th32ProcessID);
                    }
                    if Process32NextW(snap, &mut pe).is_err() {
                        break;
                    }
                }
            }

            for _ in 0..4 {
                let mut added = false;
                for &(pid, ppid) in &entries {
                    if descendants.contains(&ppid) && descendants.insert(pid) {
                        added = true;
                    }
                }
                if !added {
                    break;
                }
            }
        }

        if let Ok(enumerator) =
            CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
        {
            for role in [eConsole, eCommunications] {
                if let Ok(device) = enumerator.GetDefaultAudioEndpoint(eRender, role) {
                    if let Ok(mgr) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) {
                        if let Ok(sessions) = mgr.GetSessionEnumerator() {
                            let count = sessions.GetCount().unwrap_or(0);
                            for i in 0..count {
                                if let Ok(ctrl) = sessions.GetSession(i) {
                                    if let Ok(ctrl2) = ctrl.cast::<IAudioSessionControl2>() {
                                        if let Ok(pid) = ctrl2.GetProcessId() {
                                            if pid != 0 && descendants.contains(&pid) {
                                                return pid;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        direct_webview_child.unwrap_or(root_pid)
    }

    fn base64_encode(bytes: &[u8]) -> String {
        const TABLE: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
        for chunk in bytes.chunks(3) {
            let b0 = chunk[0] as u32;
            let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
            let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
            let n = (b0 << 16) | (b1 << 8) | b2;
            out.push(TABLE[((n >> 18) & 0x3F) as usize] as char);
            out.push(TABLE[((n >> 12) & 0x3F) as usize] as char);
            if chunk.len() > 1 {
                out.push(TABLE[((n >> 6) & 0x3F) as usize] as char);
            } else {
                out.push('=');
            }
            if chunk.len() > 2 {
                out.push(TABLE[(n & 0x3F) as usize] as char);
            } else {
                out.push('=');
            }
        }
        out
    }

    unsafe fn open_loopback_client(
    ) -> Result<(IAudioClient, IAudioCaptureClient, usize, u32), String> {
        let event_raw = CreateEventW(None, false, false, None)
            .map_err(|e| format!("CreateEventW falhou: {e}"))?;
        let event_arc = Arc::new(HandleGuard(event_raw.0 as isize));

        let target_pid = find_target_audio_pid(GetCurrentProcessId());

        let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: target_pid,
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
                },
            },
        };

        // ManuallyDrop impede que PropVariantClear tente liberar ponteiro da stack (evita 0xc0000374)
        let prop = std::mem::ManuallyDrop::new(PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                    vt: VT_BLOB,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: PROPVARIANT_0_0_0 {
                        blob: BLOB {
                            cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                            pBlobData: (&mut params as *mut AUDIOCLIENT_ACTIVATION_PARAMS)
                                .cast::<u8>(),
                        },
                    },
                }),
            },
        });

        let handler: IActivateAudioInterfaceCompletionHandler = CompletionHandler {
            event: Arc::clone(&event_arc),
        }
        .into();

        let async_op = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&*prop),
            &handler,
        )
        .map_err(|e| format!("ActivateAudioInterfaceAsync falhou: {e}"))?;

        if WaitForSingleObject(HANDLE(event_arc.0 as *mut c_void), 5000) != WAIT_OBJECT_0 {
            return Err("Timeout ao inicializar WASAPI process loopback".to_string());
        }

        let mut activate_hr = HRESULT(0);
        let mut unk: Option<IUnknown> = None;
        async_op
            .GetActivateResult(&mut activate_hr, &mut unk)
            .map_err(|e| format!("GetActivateResult falhou: {e}"))?;
        activate_hr
            .ok()
            .map_err(|e| format!("Ativação WASAPI retornou erro (requer Windows 10 2004+): {e}"))?;

        let audio_client: IAudioClient = unk
            .ok_or_else(|| "IAudioClient nulo".to_string())?
            .cast()
            .map_err(|e| format!("Cast IAudioClient falhou: {e}"))?;

        let channels: u16 = 2;
        let sample_rate: u32 = 48_000;
        let bits_per_sample: u16 = 16;
        let block_align: u16 = channels * (bits_per_sample / 8);
        let wfx = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_PCM as u16,
            nChannels: channels,
            nSamplesPerSec: sample_rate,
            nAvgBytesPerSec: sample_rate * u32::from(block_align),
            nBlockAlign: block_align,
            wBitsPerSample: bits_per_sample,
            cbSize: 0,
        };

        audio_client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK
                    | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                    | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                1_000_000,
                0,
                &wfx,
                None,
            )
            .map_err(|e| format!("IAudioClient::Initialize falhou: {e}"))?;

        let capture: IAudioCaptureClient = audio_client
            .GetService()
            .map_err(|e| format!("GetService IAudioCaptureClient falhou: {e}"))?;

        audio_client
            .Start()
            .map_err(|e| format!("IAudioClient::Start falhou: {e}"))?;

        Ok((audio_client, capture, usize::from(block_align), target_pid))
    }

    pub fn run_loopback(
        stop_flag: Arc<AtomicBool>,
        channel: Channel<String>,
        init_tx: std::sync::mpsc::Sender<Result<u32, String>>,
    ) {
        unsafe {
            if let Err(e) = CoInitializeEx(None, COINIT_MULTITHREADED).ok() {
                let _ = init_tx.send(Err(format!("CoInitializeEx falhou: {e}")));
                return;
            }
            let _com = ComGuard;

            let (mut audio_client, mut capture, bytes_per_frame, target_pid) =
                match open_loopback_client() {
                    Ok(v) => {
                        let _ = init_tx.send(Ok(v.3));
                        v
                    }
                    Err(e) => {
                        let _ = init_tx.send(Err(e));
                        return;
                    }
                };
            let _ = target_pid;

            // Lote máximo de ~20ms (960 frames * 4 bytes = 3840 bytes -> 5120 chars Base64, sempre < 8KB)
            let max_batch_bytes = 3840usize;
            let mut batch = Vec::with_capacity(max_batch_bytes);
            // Cauda de ~400ms (25 ciclos de 16ms) para manter o pre-buffer contínuo entre falas de vídeo
            let mut silent_cycles: u32 = 100;

            while !stop_flag.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(16));
                batch.clear();
                let mut device_error = false;
                let mut batch_has_sound = false;

                loop {
                    let packet_len = match capture.GetNextPacketSize() {
                        Ok(len) => len,
                        Err(_) => {
                            device_error = true;
                            break;
                        }
                    };
                    if packet_len == 0 {
                        break;
                    }

                    let mut data_ptr: *mut u8 = std::ptr::null_mut();
                    let mut num_frames: u32 = 0;
                    let mut flags: u32 = 0;

                    if capture
                        .GetBuffer(&mut data_ptr, &mut num_frames, &mut flags, None, None)
                        .is_err()
                    {
                        device_error = true;
                        break;
                    }

                    let byte_count = (num_frames as usize) * bytes_per_frame;
                    let is_silent =
                        (flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)) != 0 || data_ptr.is_null();

                    if byte_count > 0 {
                        if !is_silent {
                            let slice = std::slice::from_raw_parts(data_ptr, byte_count);
                            if slice.iter().any(|&b| b != 0) {
                                batch_has_sound = true;
                            }
                            batch.extend_from_slice(slice);
                        } else {
                            batch.resize(batch.len() + byte_count, 0);
                        }
                    }

                    let _ = capture.ReleaseBuffer(num_frames);

                    if batch.len() >= max_batch_bytes {
                        break;
                    }
                }

                if !batch.is_empty() {
                    if batch_has_sound {
                        silent_cycles = 0;
                    } else {
                        silent_cycles = silent_cycles.saturating_add(1);
                    }

                    if silent_cycles <= 25 {
                        for chunk in batch.chunks(max_batch_bytes) {
                            let _ = channel.send(base64_encode(chunk));
                        }
                    }
                }

                // Se o usuário trocou de fone/saída durante a transmissão, reabre o WASAPI automaticamente
                if device_error && !stop_flag.load(Ordering::Relaxed) {
                    let _ = audio_client.Stop();
                    std::thread::sleep(Duration::from_millis(400));
                    if let Ok((new_client, new_cap, _, _)) = open_loopback_client() {
                        audio_client = new_client;
                        capture = new_cap;
                    }
                }
            }

            let _ = audio_client.Stop();
        }
    }
}

pub struct LoopbackState {
    stop_flag: Mutex<Option<Arc<AtomicBool>>>,
}

impl Default for LoopbackState {
    fn default() -> Self {
        Self {
            stop_flag: Mutex::new(None),
        }
    }
}

impl LoopbackState {
    pub fn stop(&self) {
        if let Ok(mut guard) = self.stop_flag.lock() {
            if let Some(flag) = guard.take() {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }

    pub fn start(&self, channel: Channel<String>) -> Result<u32, String> {
        self.stop();

        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut guard) = self.stop_flag.lock() {
            *guard = Some(Arc::clone(&flag));
        }

        #[cfg(windows)]
        {
            let (tx, rx) = std::sync::mpsc::channel::<Result<u32, String>>();
            std::thread::spawn(move || {
                win_impl::run_loopback(flag, channel, tx);
            });
            match rx.recv_timeout(Duration::from_millis(3000)) {
                Ok(Ok(pid)) => Ok(pid),
                Ok(Err(e)) => {
                    self.stop();
                    Err(e)
                }
                Err(_) => {
                    self.stop();
                    Err("Timeout ao iniciar captura de áudio WASAPI".to_string())
                }
            }
        }

        #[cfg(not(windows))]
        {
            let _ = (flag, channel);
            Err("WASAPI loopback disponível apenas no Windows".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_wasapi_init() {
        let state = LoopbackState::default();
        let ch = Channel::new(|_msg| Ok(()));
        let res = state.start(ch);
        println!("WASAPI start target_pid: {:?}", res);
        assert!(res.is_ok(), "WASAPI falhou: {:?}", res);
        std::thread::sleep(Duration::from_millis(250));
        state.stop();
        std::thread::sleep(Duration::from_millis(50));
    }
}
