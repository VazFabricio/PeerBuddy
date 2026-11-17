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
        ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
        IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
        IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_LOOPBACK,
        AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, AUDIOCLIENT_ACTIVATION_PARAMS,
        AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
    };
    use windows::Win32::Media::KernelStreaming::WAVE_FORMAT_EXTENSIBLE;
    use windows::Win32::Media::Multimedia::WAVE_FORMAT_IEEE_FLOAT;
    use windows::Win32::System::Com::StructuredStorage::{
        PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
    };
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, BLOB, COINIT_MULTITHREADED};
    use windows::Win32::System::Threading::{
        CreateEventW, GetCurrentProcessId, SetEvent, WaitForSingleObject,
    };
    use windows::Win32::System::Variant::VT_BLOB;

    #[implement(IActivateAudioInterfaceCompletionHandler)]
    struct CompletionHandler {
        event: isize,
    }

    impl IActivateAudioInterfaceCompletionHandler_Impl for CompletionHandler_Impl {
        fn ActivateCompleted(
            &self,
            _activateoperation: windows::core::Ref<'_, IActivateAudioInterfaceAsyncOperation>,
        ) -> windows::core::Result<()> {
            unsafe {
                let _ = SetEvent(HANDLE(self.event as *mut c_void));
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

    struct HandleGuard(HANDLE);
    impl Drop for HandleGuard {
        fn drop(&mut self) {
            unsafe {
                if !self.0.is_invalid() {
                    let _ = CloseHandle(self.0);
                }
            }
        }
    }

    pub fn run_loopback(
        stop_flag: Arc<AtomicBool>,
        channel: Channel<Vec<u8>>,
    ) -> Result<(), String> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(|e| format!("CoInitializeEx falhou: {e}"))?;
            let _com = ComGuard;

            let event = CreateEventW(None, false, false, None)
                .map_err(|e| format!("CreateEventW falhou: {e}"))?;
            let _event_guard = HandleGuard(event);

            let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
                ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
                Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                    ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                        TargetProcessId: GetCurrentProcessId(),
                        ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
                    },
                },
            };

            let prop = PROPVARIANT {
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
            };

            let handler: IActivateAudioInterfaceCompletionHandler = CompletionHandler {
                event: event.0 as isize,
            }
            .into();

            let async_op = ActivateAudioInterfaceAsync(
                VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                &IAudioClient::IID,
                Some(&prop),
                &handler,
            )
            .map_err(|e| format!("ActivateAudioInterfaceAsync falhou: {e}"))?;

            if WaitForSingleObject(event, 5000) != WAIT_OBJECT_0 {
                return Err("Timeout ao inicializar WASAPI process loopback".to_string());
            }

            let mut activate_hr = HRESULT(0);
            let mut unk: Option<IUnknown> = None;
            async_op
                .GetActivateResult(&mut activate_hr, &mut unk)
                .map_err(|e| format!("GetActivateResult falhou: {e}"))?;
            activate_hr.ok().map_err(|e| {
                format!("Ativação WASAPI retornou erro (requer Windows 10 2004+): {e}")
            })?;

            let audio_client: IAudioClient = unk
                .ok_or_else(|| "IAudioClient nulo".to_string())?
                .cast()
                .map_err(|e| format!("Cast IAudioClient falhou: {e}"))?;

            // Formato alvo: 48 kHz, Estéreo, 32-bit float (compatível direto com AudioWorklet)
            let channels: u16 = 2;
            let sample_rate: u32 = 48_000;
            let bits_per_sample: u16 = 32;
            let block_align: u16 = channels * (bits_per_sample / 8);
            let _ = WAVE_FORMAT_EXTENSIBLE;
            let wfx = WAVEFORMATEX {
                wFormatTag: WAVE_FORMAT_IEEE_FLOAT as u16,
                nChannels: channels,
                nSamplesPerSec: sample_rate,
                nAvgBytesPerSec: sample_rate * u32::from(block_align),
                nBlockAlign: block_align,
                wBitsPerSample: bits_per_sample,
                cbSize: 0,
            };

            // Buffer de 100ms (em unidades de 100ns = 1_000_000)
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

            let bytes_per_frame = usize::from(block_align);

            while !stop_flag.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(10));

                loop {
                    let packet_len = match capture.GetNextPacketSize() {
                        Ok(len) => len,
                        Err(_) => break,
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
                        break;
                    }

                    let byte_count = (num_frames as usize) * bytes_per_frame;
                    if byte_count > 0 {
                        let buf = if (flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)) != 0
                            || data_ptr.is_null()
                        {
                            vec![0u8; byte_count]
                        } else {
                            std::slice::from_raw_parts(data_ptr, byte_count).to_vec()
                        };
                        let _ = channel.send(buf);
                    }

                    let _ = capture.ReleaseBuffer(num_frames);
                }
            }

            let _ = audio_client.Stop();
            Ok(())
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

    pub fn start(&self, channel: Channel<Vec<u8>>) -> Result<(), String> {
        self.stop();

        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut guard) = self.stop_flag.lock() {
            *guard = Some(Arc::clone(&flag));
        }

        #[cfg(windows)]
        {
            // Testa inicialização em thread dedicada e só retorna Ok quando estiver pronto
            let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
            std::thread::spawn(move || {
                // Sinaliza erro imediato se falhar antes do loop, ou Ok quando iniciar
                // Como run_loopback bloqueia no loop, usamos um wrapper simples:
                if let Err(e) = win_impl::run_loopback(flag, channel) {
                    let _ = tx.send(Err(e));
                }
            });
            // Aguarda 150ms para detectar falha imediata (ex: Windows < 10 2004)
            match rx.recv_timeout(Duration::from_millis(150)) {
                Ok(Err(e)) => {
                    self.stop();
                    Err(e)
                }
                _ => Ok(()),
            }
        }

        #[cfg(not(windows))]
        {
            let _ = (flag, channel);
            Err("WASAPI loopback disponível apenas no Windows".to_string())
        }
    }
}
