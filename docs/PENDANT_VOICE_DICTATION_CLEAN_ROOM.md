## Binary path
/media/jang/home/Deve/vsix-amulet/extension/dist/voice/

## Voice dictation

Pendant lets you speak a message instead of typing it. Speech recognition runs entirely on your computer. Your audio never leaves it, and neither does the text made from it. The only thing dictation downloads is a speech model, and only when you first need it.

### How it works

1. Your microphone recorded by a small helper program
2. whisper.cpp turns speech into text on your computer
3. The composer the text appears at your cursor

When you start dictating, Pendant starts a small helper program that ships with it and records from your microphone. The helper runs only while you dictate. Each dictation starts a fresh one, and it closes once the text is ready.

While you speak, Pendant shows how loud the input is, so you can see that it hears you. When you stop, the helper trims the silence at the start and the end of the recording. It then hands the recording to whisper.cpp, an open-source speech recognition engine, together with the model file. whisper.cpp runs inside the helper, on your computer. Nothing is sent over the network, and no audio or text reaches Pendant's developers or anyone else.

The text goes into the composer, at your cursor. Pendant does not send it for you. You can read it, correct it and send it when you are ready. If the result is wrong, you can remove the text you just dictated in one step.

By default you hold the microphone button while you speak and let go to stop. A quick click starts and stops dictation as well. You can turn off holding in Pendant's settings. Dictation uses your system's default microphone unless you choose another one there.

### Models

whisper.cpp needs a model file. Pendant offers the whisper.cpp models in two sizes. Tiny is faster. Base recognises speech more accurately. Each size comes in a multilingual version and an English-only version. And each of those comes as a full build and as a smaller quantized build, named Q5_1, which trades a little accuracy for a smaller download.

| Model | Languages | File | Download size |
| --- | --- | --- | --- |
| Base multilingual, the default | Many languages | `ggml-base.bin` | about 142 MB |
| Base multilingual (Q5_1), recommended | Many languages | `ggml-base-q5_1.bin` | about 57 MB |
| Tiny multilingual | Many languages | `ggml-tiny.bin` | about 75 MB |
| Tiny multilingual (Q5_1) | Many languages | `ggml-tiny-q5_1.bin` | about 31 MB |
| Base English | English only | `ggml-base.en.bin` | about 142 MB |
| Base English (Q5_1), recommended | English only | `ggml-base.en-q5_1.bin` | about 57 MB |
| Tiny English | English only | `ggml-tiny.en.bin` | about 75 MB |
| Tiny English (Q5_1) | English only | `ggml-tiny.en-q5_1.bin` | about 31 MB |

Pendant recommends the quantized Base builds. They are smaller than the full Tiny builds and still more accurate. English-only models are more accurate for English, so they suit you if English is all you dictate.

When Pendant needs a model, it shows a dialog that lists these models. For each one it shows the languages, the speed, the download size and the exact download address. You can open the same dialog later to switch models or to change the language and microphone.

### Using your own model file

You can also use a whisper.cpp model file you already have, for example a larger one than Pendant offers. Give Pendant the file's full path, in the dictation dialog or in Pendant's settings. Pendant then uses that file directly and never downloads a model. The path must be absolute, and the file must exist. The file must be in the format whisper.cpp reads. Which languages it understands depends on the model.

### Where models come from

Pendant downloads the built-in models from Hugging Face, from the model repository of the whisper.cpp project at `huggingface.co/ggerganov/whisper.cpp`. That request goes to Hugging Face, which sees ordinary network information such as your IP address. The [Privacy Policy](https://pendant.sh/privacy) describes this in detail.

A download happens only when you dictate with a model that is not on your computer yet, or when you choose such a model in the dictation dialog. Pendant downloads only the model you selected and shows its progress. It writes the file under a temporary name and keeps it only once the download is complete. It does not compare the file against a checksum.

Downloaded models are kept in Pendant's own storage on your computer, not in your project. They stay there until you delete them. Pendant can show how much space they take and delete them for you. A model file of your own stays where it is.

### Languages

The multilingual models transcribe the languages whisper.cpp supports, for example German, Chinese or Spanish. Pendant does not detect the language you speak. You choose it, and dictation transcribes that language. English is the default. The dialog that lists the models also asks for the language, and you can change it in the dictation dialog or in Pendant's settings. Cantonese is not offered separately. Choose Chinese for it.

English-only models ignore the language setting. They always produce English.

### Speed and hardware

Smaller models transcribe faster. On a Mac with Apple silicon, whisper.cpp uses the graphics processor. On an Intel Mac, on Windows and on Linux, it runs on the processor.

### Offline

Dictation itself never needs the internet. Once a model is on your computer, dictation works without a connection. With Pendant's offline setting turned on, Pendant never downloads a model. If the selected model is not on your computer yet, dictation says so instead. A model file of your own always works offline.

### Microphone permission

Pendant uses the microphone only when you start dictating.

 * **macOS** asks for permission the first time. The request names the app Pendant runs in, or Pendant's helper. If you deny it, dictation shows an error. You can allow it later in the system's privacy settings.
 * **Windows and Linux** do not get a prompt from Pendant. The microphone follows your system's own privacy and sound settings.

If no microphone is available, dictation tells you.

### The first time

The first time you press the microphone button, Pendant opens the model dialog. You choose a model, or your own file, and the language. That press ends with your choice, and the model downloads straight away. The next press dictates.

Dictation works on macOS, Windows and Linux. On Windows and Linux, both x64 and Arm processors are supported.

Source: https://pendant.sh/guide/voice