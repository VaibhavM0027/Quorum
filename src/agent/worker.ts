import "dotenv/config";

import { fileURLToPath } from "node:url";
import {
  AutoSubscribe,
  cli,
  defineAgent,
  ServerOptions,
  WorkerPermissions,
  type JobContext,
  type JobProcess,
} from "@livekit/agents";
import {
  ParticipantKind,
  RoomEvent,
  TrackKind,
  type Participant,
  type RemoteAudioTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type TrackPublication,
} from "@livekit/rtc-node";
import { transcriptLog, transcriptWarn } from "@/lib/debug-log";
import { browserLivekitUrl, parseRoomName } from "@/lib/livekit";
import { prisma } from "@/lib/prisma";
import { ParticipantTranscriber, type SpeakerRef } from "./participant-session";

/**
 * The transcription agent.
 *
 * One agent process is dispatched per live discussion room and subscribes to
 * every participant's microphone. Each microphone gets its own
 * {@link ParticipantTranscriber}, so a participant's speech is recognised from
 * their audio alone and can never be attributed to whoever happened to be
 * loudest in a shared stream.
 *
 * This is the whole reason the agent exists: a browser can only transcribe the
 * microphone attached to it, so before this worker the only participant whose
 * words reached the transcript was the one whose own laptop was running the
 * recogniser — normally the host's.
 */

/**
 * How often consent and membership are re-read while a job runs.
 *
 * "Stop transcribing my voice" is a button in the browser and the audio is in
 * this process, so the only way the agent hears about it is by asking again.
 */
const ELIGIBILITY_INTERVAL_MS = 15_000;

/** One participant's microphone, together with the transcriber reading it. */
type Attachment = {
  identity: string;
  speaker: SpeakerRef;
  transcriber: ParticipantTranscriber;
};

/** Only audio is transcribed; a camera track is skipped outright. */
function isAudio(publication: TrackPublication): boolean {
  return publication.kind === TrackKind.KIND_AUDIO;
}

export default defineAgent({
  prewarm: (proc: JobProcess) => {
    transcriptLog("transcription worker process ready", { pid: proc.pid });
  },

  entry: async (ctx: JobContext) => {
    const roomId = ctx.job.room?.name ?? "";
    const parsed = parseRoomName(roomId);
    if (!parsed) {
      transcriptWarn("agent called into a room that is not a discussion", { roomId });
      return;
    }
    const { discussionId } = parsed;

    // The agent is dispatched as soon as a room exists, which can be before the
    // host has started the discussion. Nothing is recorded until it is live.
    const discussion = await prisma.discussion.findUnique({
      where: { id: discussionId },
      select: { id: true, status: true, transcriptionEnabled: true },
    });
    if (!discussion) {
      transcriptWarn("agent called for a discussion that does not exist", { roomId, discussionId });
      return;
    }
    if (!discussion.transcriptionEnabled) {
      transcriptLog("transcription is disabled for this discussion", { roomId, discussionId });
      return;
    }
    if (discussion.status !== "LIVE") {
      transcriptLog("discussion is not live yet; not transcribing", {
        roomId,
        discussionId,
        status: discussion.status,
      });
      return;
    }

    await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_ALL);
    transcriptLog("transcription agent joined the room", {
      roomId,
      discussionId,
      breakoutRoom: parsed.breakoutRoom,
      participants: ctx.room.remoteParticipants.size,
    });

    /** Every microphone currently being transcribed, keyed by track. */
    const attachments = new Map<string, Attachment>();

    /** Maps a LiveKit identity to the discussion member it belongs to. */
    const resolveSpeaker = async (identity: string): Promise<SpeakerRef | null> => {
      const member = await prisma.discussionParticipant.findUnique({
        where: { discussionId_userId: { discussionId, userId: identity } },
        select: { id: true, displayName: true, removed: true, transcriptionConsent: true },
      });
      if (!member) {
        transcriptWarn("audio ignored: speaker is not a participant of this discussion", {
          roomId,
          discussionId,
          participantIdentity: identity,
        });
        return null;
      }
      if (member.removed || !member.transcriptionConsent) {
        transcriptWarn("audio ignored: no transcription consent on record", {
          roomId,
          participantIdentity: identity,
          removed: member.removed,
        });
        return null;
      }
      transcriptLog("participant identity mapped", {
        roomId,
        participantId: member.id,
        participantIdentity: identity,
        participantName: member.displayName,
      });
      return { id: member.id, displayName: member.displayName };
    };

    const attach = async (
      participant: RemoteParticipant,
      publication: RemoteTrackPublication,
      track: RemoteAudioTrack,
      reason: string,
    ): Promise<void> => {
      const trackId = publication.sid;
      if (!trackId || attachments.has(trackId)) return;

      const speaker = await resolveSpeaker(participant.identity);
      if (!speaker) return;

      // Resolving the speaker takes a database round trip, and the track can be
      // gone by the time it answers — a mute, a reconnect, a participant
      // leaving. Attaching to it anyway would strand a reader on a dead track.
      if (attachments.has(trackId)) return;
      if (publication.subscribed === false) return;
      if (!ctx.room.remoteParticipants.has(participant.identity)) return;

      transcriptLog("remote audio track subscribed", {
        roomId,
        participantIdentity: participant.identity,
        participantName: speaker.displayName,
        trackId,
        reason,
      });

      const transcriber = new ParticipantTranscriber({
        discussionId,
        roomId,
        participantIdentity: participant.identity,
        trackId,
        speaker,
        track,
      });
      // Recorded before start() so a concurrent reconcile sees it as attached.
      attachments.set(trackId, { identity: participant.identity, speaker, transcriber });
      transcriber.start();
    };

    /**
     * Detaches one track, keeping whatever was said on it.
     *
     * Every way audio can end comes through here — mute, unpublish,
     * unsubscribe, disconnect, room close — so a sentence is never lost just
     * because the microphone went quiet mid-word.
     */
    const detach = (trackId: string): void => {
      const attachment = attachments.get(trackId);
      if (!attachment) return;
      attachments.delete(trackId);
      attachment.transcriber.stop();
    };

    const detachAllFor = (identity: string): void => {
      for (const trackId of [...attachments.keys()]) {
        if (attachments.get(trackId)?.identity === identity) detach(trackId);
      }
    };

    /** A microphone worth transcribing: subscribed, present, and unmuted. */
    const isLiveMicrophone = (publication: RemoteTrackPublication): boolean =>
      isAudio(publication) && publication.track !== undefined && !publication.muted;

    /**
     * Makes the running transcribers match the audio actually in the room.
     *
     * LiveKit can deliver these events in any order around a join, a reconnect
     * or a renegotiation, so rather than trusting each event to be the whole
     * story this recomputes the set each time. Events that arrive doubled or
     * out of order therefore cost nothing: a second call attaches nothing new.
     */
    const syncTracks = (reason: string): void => {
      const wanted = new Set<string>();

      for (const participant of ctx.room.remoteParticipants.values()) {
        // Another agent is not a speaker, and its audio must never be
        // transcribed as if it were a participant's.
        if (participant.kind === ParticipantKind.AGENT) continue;

        for (const publication of participant.trackPublications.values()) {
          const remote = publication as RemoteTrackPublication;
          if (!isLiveMicrophone(remote)) continue;
          const trackId = remote.sid;
          if (!trackId) continue;
          wanted.add(trackId);
          if (!attachments.has(trackId)) {
            void attach(participant, remote, remote.track as RemoteAudioTrack, reason);
          }
        }
      }

      for (const trackId of [...attachments.keys()]) {
        if (!wanted.has(trackId)) detach(trackId);
      }
    };

    ctx.room
      .on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
        transcriptLog("participant connected", {
          roomId,
          participantIdentity: participant.identity,
          participantName: participant.name ?? participant.identity,
          participants: ctx.room.remoteParticipants.size,
        });
        syncTracks("participant connected");
      })
      .on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
        transcriptLog("participant disconnected", {
          roomId,
          participantIdentity: participant.identity,
        });
        detachAllFor(participant.identity);
      })
      .on(RoomEvent.TrackPublished, (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (!isAudio(publication)) return;
        transcriptLog("remote audio track detected", {
          roomId,
          participantIdentity: participant.identity,
          participantName: participant.name ?? participant.identity,
          trackId: publication.sid,
        });
        syncTracks("track published");
      })
      .on(
        RoomEvent.TrackSubscribed,
        (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
          if (!isAudio(publication)) return;
          void attach(participant, publication, track as RemoteAudioTrack, "track subscribed");
        },
      )
      .on(
        RoomEvent.TrackUnsubscribed,
        (_track: RemoteTrack, publication: RemoteTrackPublication) => detach(publication.sid ?? ""),
      )
      .on(RoomEvent.TrackUnpublished, (publication: RemoteTrackPublication) =>
        detach(publication.sid ?? ""),
      )
      .on(RoomEvent.TrackMuted, (publication: TrackPublication, participant: Participant) => {
        if (!isAudio(publication)) return;
        transcriptLog("participant microphone muted", {
          roomId,
          participantIdentity: participant.identity,
          trackId: publication.sid,
        });
        detach(publication.sid ?? "");
      })
      .on(RoomEvent.TrackUnmuted, (publication: TrackPublication, participant: Participant) => {
        if (!isAudio(publication)) return;
        transcriptLog("participant microphone unmuted", {
          roomId,
          participantIdentity: participant.identity,
          trackId: publication.sid,
        });
        syncTracks("track unmuted");
      })
      .on(RoomEvent.TrackSubscriptionFailed, (trackId: string, participant: RemoteParticipant) => {
        transcriptWarn("could not subscribe to a participant's audio", {
          roomId,
          participantIdentity: participant.identity,
          trackId,
        });
      })
      // After a reconnect the tracks are re-negotiated: new track ids, and
      // session ids that no longer exist. Recomputing from the room state
      // retires the stale attachments and picks the live ones up.
      .on(RoomEvent.Reconnected, () => {
        transcriptLog("transcription agent reconnected to the room", { roomId });
        syncTracks("reconnected");
      });

    /**
     * Re-checks consent for everyone currently being transcribed.
     *
     * A participant who withdraws consent, or is removed by the host, is
     * detached within one interval — the agent must not keep listening to
     * somebody the discussion has stopped listening to.
     */
    const enforceEligibility = async (): Promise<void> => {
      if (attachments.size === 0) return;
      const identities = [...new Set([...attachments.values()].map((entry) => entry.identity))];

      const members = await prisma.discussionParticipant.findMany({
        where: { discussionId, userId: { in: identities } },
        select: { userId: true, removed: true, transcriptionConsent: true },
      });
      const allowed = new Set(
        members.filter((member) => !member.removed && member.transcriptionConsent).map((m) => m.userId),
      );

      for (const identity of identities) {
        if (allowed.has(identity)) continue;
        transcriptWarn("participant audio detached: no longer eligible to be transcribed", {
          roomId,
          participantIdentity: identity,
        });
        detachAllFor(identity);
      }
    };

    const eligibilityTimer = setInterval(() => {
      void enforceEligibility().catch((error: unknown) => {
        transcriptWarn("could not re-check transcription eligibility", {
          roomId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, ELIGIBILITY_INTERVAL_MS);

    ctx.addShutdownCallback(async () => {
      clearInterval(eligibilityTimer);
      for (const trackId of [...attachments.keys()]) detach(trackId);
      transcriptLog("transcription agent left the room", { roomId, discussionId });
    });

    // Participants who were already speaking when this agent was dispatched —
    // a discussion that has been running for a while before the agent is
    // available, or a worker that was restarted mid-discussion.
    syncTracks("agent joined");
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const permissions = new WorkerPermissions();
  // The agent is infrastructure, not a person: it publishes nothing and must
  // not appear in anyone's participant list or seat map.
  permissions.hidden = true;

  // The agents CLI reads LIVEKIT_URL and nothing else, while local development
  // configures LIVEKIT_HOST and leaves LIVEKIT_URL blank. Both name the same
  // server — the worker joins the very room the browsers are in — so fill the
  // blank in. LiveKit Cloud sets LIVEKIT_URL explicitly and wins.
  process.env.LIVEKIT_URL ||= browserLivekitUrl();

  cli.runApp(
    new ServerOptions({
      // The job process is a plain Node child, but it inherits this process's
      // command line, so the worker must be started with the TypeScript loader
      // on it (`node --import tsx src/agent/worker.ts start`). See package.json.
      agent: fileURLToPath(import.meta.url),
      permissions,
    }),
  );
}
