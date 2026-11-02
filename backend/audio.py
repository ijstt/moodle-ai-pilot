"""
Audio Processing Module for Moodle AI Pilot.
Performs high-speed Speech-to-Text using faster-whisper and ffmpeg PCM stream.
"""

import base64
import numpy as np
import os
import subprocess
import tempfile
from typing import Optional

_whisper_model = None


def get_whisper(model_size: str = "base.en"):
    """
    Lazily loads the Whisper model on CPU with int8 quantization.
    """
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        _whisper_model = WhisperModel(model_size, device="cpu", compute_type="int8")
    return _whisper_model


def transcribe_audio_base64(audio_b64: str, model_size: str = "base.en") -> str:
    """
    Decodes Base64 audio into 16kHz mono s16le PCM via ffmpeg and transcribes it.
    Direct PCM piping bypasses PyAV container issues across modern Python versions.
    """
    if not audio_b64:
        return ""

    try:
        if "," in audio_b64:
            audio_b64 = audio_b64.split(",", 1)[1]

        raw_data = base64.b64decode(audio_b64)

        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
            temp_path = f.name
            f.write(raw_data)

        cmd = [
            "ffmpeg", "-nostdin", "-threads", "0", "-i", temp_path,
            "-f", "s16le", "-ac", "1", "-ar", "16000", "-"
        ]
        out = subprocess.run(cmd, capture_output=True, check=True).stdout
        audio_array = np.frombuffer(out, np.int16).flatten().astype(np.float32) / 32768.0

        model = get_whisper(model_size=model_size)
        segments, _ = model.transcribe(audio_array, language="en", beam_size=3)
        transcript = " ".join([seg.text.strip() for seg in segments])

        os.remove(temp_path)
        return transcript

    except Exception as e:
        print(f"[Audio] Transcription error: {e}")
        return ""
