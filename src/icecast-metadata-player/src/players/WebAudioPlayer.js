import { OpusDecoderWebWorker } from "opus-decoder";
import { MPEGDecoderWebWorker } from "mpg123-decoder";

import FrameQueue from "../FrameQueue.js";
import {
  state,
  event,
  SYNCED,
  SYNCING,
  NOT_SYNCED,
  fireEvent,
} from "../global.js";
import Player from "./Player.js";

export default class WebAudioPlayer extends Player {
  constructor(icecast, inputMimeType, codec) {
    super(icecast, inputMimeType, codec);

    this._icecast.addEventListener(event.RETRY, () => {
      this._syncState = NOT_SYNCED;
    });
    this._icecast.addEventListener(event.STREAM_START, () => {
      if (!this._wasmDecoder) this._getWasmDecoder();
    });

    this._audioContext = WebAudioPlayer.constructor.audioContext;

    this._getWasmDecoder();
    this.reset();
  }

  static canPlayType(mimeType) {
    const mapping = {
      mpeg: ["audio/mpeg"],
      ogg: {
        opus: ['audio/ogg;codecs="opus"'],
      },
    };

    if (!WebAudioPlayer.isSupported) return "";

    return super.canPlayType(
      (codec) => codec === 'audio/ogg;codecs="opus"' || codec === "audio/mpeg",
      mimeType,
      mapping
    );
  }

  static get isSupported() {
    return Boolean(
      window.WebAssembly &&
        (window.AudioContext || window.webkitAudioContext) &&
        window.MediaStream
    );
  }

  static get name() {
    return "webaudio";
  }

  get isAudioPlayer() {
    return true;
  }

  get metadataTimestamp() {
    return this._currentTime / 1000;
  }

  get currentTime() {
    return (performance.now() - this._playbackStartTime) / 1000 || 0;
  }

  _getWasmDecoder() {
    switch (this._codec) {
      case "mpeg":
        this._wasmDecoder = new MPEGDecoderWebWorker();
        break;
      case "opus":
        this._wasmDecoder = new OpusDecoderWebWorker();
        break;
    }

    this._wasmReady = this._wasmDecoder.ready;
  }

  async reset() {
    this._syncState = SYNCED;
    this._syncSuccessful = false;
    this._frameQueue = new FrameQueue(this._icecast);

    this._currentTime = 0;
    this._decodedSample = 0;
    this._decodedSampleOffset = 0;
    this._sampleRate = 0;
    this._playbackStartTime = undefined;
    this._playReady = false;

    if (
      this._icecast.state === state.STOPPING ||
      this._icecast.state === state.STOPPED
    ) {
      if (this._wasmDecoder) {
        const decoder = this._wasmDecoder;
        this._wasmReady.then(() => {
          decoder.free();
        });
        this._wasmDecoder = null;
      }

      if (this._mediaStream) {
        // disconnect the currently playing media stream
        this._mediaStream.disconnect();
        this._mediaStream = null;
      }

      this._audioElement.srcObject = new MediaStream();
    }
  }

  async onStream(oggPages) {
    let frames = oggPages.flatMap((oggPage) => oggPage.codecFrames || oggPage);

    switch (this._syncState) {
      case NOT_SYNCED:
        this._frameQueue.initSync();
        this._syncState = SYNCING;
      case SYNCING:
        [frames, this._syncSuccessful] = this._frameQueue.sync(frames);

        if (frames.length) {
          this._syncState = SYNCED;

          if (!this._syncSuccessful) await this.reset();
        }
      case SYNCED:
        if (frames.length) {
          this._currentTime = frames[frames.length - 1].totalDuration;

          await this._wasmReady;
          this._decodeAndPlay(frames);
        }
      default:
        this._frameQueue.addAll(frames); // always add frames
    }
  }

  async _decodeAndPlay(frames) {
    const { channelData, samplesDecoded, sampleRate } =
      await this._wasmDecoder.decodeFrames(frames.map((f) => f.data));

    if (
      this._icecast.state !== state.STOPPING &&
      this._icecast.state !== state.STOPPED &&
      samplesDecoded
    ) {
      this._icecast[fireEvent](event.STREAM, {
        channelData,
        samplesDecoded,
        sampleRate,
      });

      if (!this._sampleRate) {
        this._sampleRate = sampleRate;

        this._mediaStream = this._audioContext.createMediaStreamDestination();
        this._audioElement.srcObject = this._mediaStream.stream; // triggers canplay event
      }

      const decodeDuration =
        (this._decodedSample + this._decodedSampleOffset) / this._sampleRate;

      if (decodeDuration < this._audioContext.currentTime) {
        // audio context time starts incrementing immediately when it's created
        // offset needs to be accounted for to prevent overlapping sources
        this._decodedSampleOffset += Math.floor(
          this._audioContext.currentTime * this._sampleRate
        );
      }

      const audioBuffer = this._audioContext.createBuffer(
        channelData.length,
        samplesDecoded,
        this._sampleRate
      );

      channelData.forEach((channel, idx) =>
        audioBuffer.getChannelData(idx).set(channel)
      );

      const source = this._audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this._mediaStream);
      source.start(decodeDuration);

      if (!this._playReady) {
        if (this._bufferLength <= this.metadataTimestamp) {
          this._icecast[fireEvent](event.PLAY_READY);
          this._playbackStartTime = performance.now();

          this._startMetadata();
          this._icecast[fireEvent](event.PLAY);
          this._playReady = true;
        } else {
          this._icecast[fireEvent](event.BUFFER, this.metadataTimestamp);
        }
      }

      this._decodedSample += samplesDecoded;
    }
  }
}

// statically initialize audio context and start using a DOM event
if (WebAudioPlayer.isSupported) {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)({
    latencyHint: "playback",
  });

  const audioCtxErrorHandler = (e) => {
    console.error(
      "icecast-metadata-js",
      "Failed to start the AudioContext. WebAudio playback will not be possible.",
      e
    );
  };

  // hack for iOS Audio element controls support
  // iOS will only enable AudioContext.resume() when called directly from a UI event
  // https://stackoverflow.com/questions/57510426
  const events = ["touchstart", "touchend", "mousedown", "keydown"];

  const unlock = () => {
    audioCtx
      .resume()
      .then(() => {
        events.forEach((e) => document.removeEventListener(e, unlock));

        // hack for iOS to continue playing while locked
        audioCtx
          .createScriptProcessor(2 ** 14, 2, 2)
          .connect(audioCtx.destination);

        audioCtx.onstatechange = () => {
          if (audioCtx.state !== "running")
            audioCtx.resume().catch(audioCtxErrorHandler);
        };
      })
      .catch(audioCtxErrorHandler);
  };

  events.forEach((e) => document.addEventListener(e, unlock));

  WebAudioPlayer.constructor.audioContext = audioCtx;
}
