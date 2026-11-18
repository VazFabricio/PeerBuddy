mod audio_loopback;

use audio_loopback::LoopbackState;
use tauri::ipc::Channel;
use tauri::State;

#[tauri::command]
fn start_screen_audio(
    state: State<'_, LoopbackState>,
    on_audio: Channel<String>,
) -> Result<u32, String> {
    state.start(on_audio)
}

#[tauri::command]
fn stop_screen_audio(state: State<'_, LoopbackState>) {
    state.stop();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(LoopbackState::default())
        .invoke_handler(tauri::generate_handler![
            start_screen_audio,
            stop_screen_audio
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o PeerBuddy");
}
