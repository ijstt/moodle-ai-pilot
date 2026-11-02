import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

from audio import transcribe_audio_base64


def test_transcribe_audio_empty_input():
    result = transcribe_audio_base64("")
    assert result == ""


def test_transcribe_audio_invalid_base64():
    result = transcribe_audio_base64("not-valid-base64-content!@#$")
    assert result == ""
