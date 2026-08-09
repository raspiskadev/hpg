/**
 * Tactical Dispatcher Console - WebRTC & Socket.IO Engine
 * Handles PTT Audio Streams, Peer-to-Peer & Group Messaging, Media Transfers,
 * WebRTC Video/Audio Calling, and Remote Device Overrides.
 */

class DispatcherConsole {
  constructor(config = {}) {
    this.serverUrl = config.serverUrl || "http://localhost:3000";
    this.dispatcherId = config.dispatcherId || "DISPATCH_MAIN";
    this.socket = null;

    // Active State Trackers
    this.selectedUnit = "ALL"; // Default target: Group Broadcast
    this.activePeerConnections = {}; // Map of unitId -> RTCPeerConnection
    this.mediaRecorders = {}; // PTT MediaRecorder instances
    this.localStream = null;
    this.remoteStreams = {};

    // Ice Servers configuration (Include your Coturn STUN/TURN credentials here)
    this.rtcConfig = {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        // { urls: "turn:your-turn-server.com:3478", username: "user", credential: "pass" }
      ],
    };

    // Callback Hooks for UI Integration
    this.onMessageReceived = config.onMessageReceived || null;
    this.onTelemetryReceived = config.onTelemetryReceived || null;
    this.onRemoteStreamAdded = config.onRemoteStreamAdded || null;
    this.onPTTAudioChunk = config.onPTTAudioChunk || null;

    this.init();
  }

  /**
   * Initialize Socket.IO connection and system event bindings
   */
  init() {
    this.socket = io(this.serverUrl, {
      query: { unit_id: this.dispatcherId, role: "DISPATCHER" },
    });

    this.socket.on("connect", () => {
      console.log(`[Dispatcher] Connected to server as ${this.dispatcherId}`);
      // Join Main Dispatcher Room & Tactical Group Room
      this.socket.emit("REGISTER_DEVICE", {
        unit_id: this.dispatcherId,
        role: "DISPATCHER",
      });
    });

    // Listen for incoming messages and PTT
    this.socket.on("TACTICAL_MESSAGE", (data) => this.handleIncomingMessage(data));
    this.socket.on("PTT_AUDIO_CHUNK", (data) => this.handleIncomingPTT(data));
    this.socket.on("SIGNAL_EXCHANGE", (data) => this.handleSignalingData(data));
    this.socket.on("TELEMETRY_REPORT", (data) => {
      if (this.onTelemetryReceived) this.onTelemetryReceived(data);
    });
  }

  /**
   * Set target recipient for communications ("ALL", "HPG_UNIT_1", "HPG_UNIT_2")
   */
  setSelectedUnit(unitId) {
    this.selectedUnit = unitId;
    console.log(`[Dispatcher] Target updated to: ${this.selectedUnit}`);
  }

  /* =========================================================================
     1. PUSH-TO-TALK (PTT) HALF-DUPLEX STREAMING ENGINE
     ========================================================================= */

  /**
   * Start pressing PTT key (Call this on mousedown/keydown)
   */
  async startPTTTransmission() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });

      this.mediaRecorders["PTT"] = { recorder: mediaRecorder, stream: stream };

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && this.socket) {
          const reader = new FileReader();
          reader.readAsDataURL(event.data);
          reader.onloadend = () => {
            const base64Audio = reader.result.split(",")[1];
            this.socket.emit("PTT_AUDIO_CHUNK", {
              sender_id: this.dispatcherId,
              target_unit: this.selectedUnit,
              priority: 0, // Dispatcher Priority Override
              audio_payload_base64: base64Audio,
              timestamp: Date.now(),
            });
          };
        }
      };

      // Emit audio chunks every 100ms for continuous streaming
      mediaRecorder.start(100);
      console.log(`[PTT] Transmitting to target: ${this.selectedUnit}...`);
    } catch (err) {
      console.error("[PTT] Failed to capture microphone:", err);
    }
  }

  /**
   * Release PTT key (Call this on mouseup/keyup)
   */
  stopPTTTransmission() {
    if (this.mediaRecorders["PTT"]) {
      const { recorder, stream } = this.mediaRecorders["PTT"];
      recorder.stop();
      stream.getTracks().forEach((track) => track.stop());
      delete this.mediaRecorders["PTT"];
      console.log("[PTT] Transmission ended.");
    }
  }

  /**
   * Play incoming PTT audio chunks from field units
   */
  handleIncomingPTT(data) {
    if (data.sender_id === this.dispatcherId) return; // Ignore own echoes

    const audioUrl = `data:audio/webm;codecs=opus;base64,${data.audio_payload_base64}`;
    const audio = new Audio(audioUrl);
    audio.play().catch((e) => console.error("[PTT Playback Error]", e));

    if (this.onPTTAudioChunk) this.onPTTAudioChunk(data);
  }

  /* =========================================================================
     2. TEXT, MEDIA & TASK DISPATCH MESSAGING
     ========================================================================= */

  /**
   * Send text message or assign a geographical target destination
   */
  sendTextMessage(text, taskPayload = null) {
    const payload = {
      message_id: "msg_" + Date.now(),
      sender: this.dispatcherId,
      recipient: this.selectedUnit,
      timestamp: Date.now(),
      text: text,
      task: taskPayload, // Optional JSON object containing target lat/lng destination
    };

    this.socket.emit("TACTICAL_MESSAGE", payload);
    return payload;
  }

  /**
   * Upload and send Media Attachment (Images, Videos, Voice Recordings)
   */
  sendMediaAttachment(file, fileType = "IMAGE") {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const payload = {
        message_id: "media_" + Date.now(),
        sender: this.dispatcherId,
        recipient: this.selectedUnit,
        timestamp: Date.now(),
        type: fileType, // "IMAGE", "VIDEO", "AUDIO"
        file_name: file.name,
        file_data_base64: reader.result,
      };
      this.socket.emit("TACTICAL_MESSAGE", payload);
    };
  }

  handleIncomingMessage(data) {
    console.log("[Message Received]", data);
    if (this.onMessageReceived) this.onMessageReceived(data);
  }

  /* =========================================================================
     3. FULL-DUPLEX WEBRTC VOICE & VIDEO CALLING
     ========================================================================= */

  /**
   * Initiate a WebRTC Audio/Video Call to a field unit
   */
  async startCall(targetUnitId, includeVideo = true) {
    console.log(`[WebRTC] Initiating call to ${targetUnitId}`);
    const peerConnection = this.createPeerConnection(targetUnitId);

    // Get local camera/mic stream
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: includeVideo,
    });

    this.localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, this.localStream);
    });

    // Create and send SDP Offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    this.socket.emit("SIGNAL_EXCHANGE", {
      target_id: targetUnitId,
      sender_id: this.dispatcherId,
      signalData: { type: "offer", sdp: offer.sdp },
    });
  }

  /**
   * Handle WebRTC Signaling (Offers, Answers, and ICE Candidates)
   */
  async handleSignalingData(data) {
    const { sender_id, signalData } = data;
    let pc = this.activePeerConnections[sender_id];

    if (!pc) {
      pc = this.createPeerConnection(sender_id);
    }

    if (signalData.type === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(signalData));
      
      // Auto-answer on dispatcher console or prompt UI
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      this.localStream.getTracks().forEach((track) => pc.addTrack(track, this.localStream));

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      this.socket.emit("SIGNAL_EXCHANGE", {
        target_id: sender_id,
        sender_id: this.dispatcherId,
        signalData: { type: "answer", sdp: answer.sdp },
      });
    } else if (signalData.type === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(signalData));
    } else if (signalData.candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
    }
  }

  createPeerConnection(targetUnitId) {
    const pc = new RTCPeerConnection(this.rtcConfig);

    // Send ICE candidates via signaling server
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit("SIGNAL_EXCHANGE", {
          target_id: targetUnitId,
          sender_id: this.dispatcherId,
          signalData: { candidate: event.candidate },
        });
      }
    };

    // Attach incoming remote audio/video tracks
    pc.ontrack = (event) => {
      console.log(`[WebRTC] Received remote track from ${targetUnitId}`);
      this.remoteStreams[targetUnitId] = event.streams[0];
      if (this.onRemoteStreamAdded) {
        this.onRemoteStreamAdded(targetUnitId, event.streams[0]);
      }
    };

    this.activePeerConnections[targetUnitId] = pc;
    return pc;
  }

  endCall(targetUnitId) {
    if (this.activePeerConnections[targetUnitId]) {
      this.activePeerConnections[targetUnitId].close();
      delete this.activePeerConnections[targetUnitId];
      console.log(`[WebRTC] Call with ${targetUnitId} ended.`);
    }
  }

  /* =========================================================================
     4. REMOTE COMMAND OVERRIDES (CAMERA, MIC, ALARM, TELEMETRY PING)
     ========================================================================= */

  /**
   * Execute forced remote command on target unit's Android background service
   * @param {string} commandType - "FORCE_CAMERA_STREAM", "FORCE_MIC_STREAM", "FORCE_ALARM", "PING_TELEMETRY"
   */
  executeRemoteOverride(commandType, targetUnitId = null) {
    const target = targetUnitId || this.selectedUnit;
    if (target === "ALL" && commandType !== "FORCE_ALARM") {
      console.warn("[Override] Remote stream overrides must target a specific unit.");
      return;
    }

    const payload = {
      command_id: "cmd_" + Date.now(),
      target_unit: target,
      issuer: this.dispatcherId,
      action: commandType,
      timestamp: Date.now(),
    };

    this.socket.emit("DISPATCH_OVERRIDE_COMMAND", payload);
    console.log(`[Override Issued] Action: ${commandType} -> Target: ${target}`);
  }
}