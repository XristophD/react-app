import produce from 'immer';
import { mountStoreDevtool } from 'simple-zustand-devtools';
import create from 'zustand';
import { conferenceOptions } from '../components/JitsiConnection/options';
import { getVolumeByDistance } from '../utils/VectorHelpers';
import { useConnectionStore } from './ConnectionStore';
import { useLocalStore } from './LocalStore';

// # TS DEFINITIONS *******************************************

declare global {
  interface Window {
    JitsiMeetJS: any
  }
}

export type Track = {
  track:{id:string}
  containers:any[]
  getType: () => 'video'|'audio'
  dispose: () => void
  isLocal: () => boolean
  isMuted: () => boolean
  mute: () => void
  unmute: () => void
  addEventListener: (eventType:string,callback:(...rest)=>void) => boolean
  removeEventListener: (eventType:string,callback:(...rest)=>void) => boolean
  getParticipantId: () => ID
  attach: (element:HTMLElement) => void
  detach: (element:HTMLElement) => void
}
export type AudioTrack = Track
export type VideoTrack = Track 

export type User = { id:ID, mute:boolean, volume:number, pos:Point, audio?:AudioTrack, video?:VideoTrack }
type Users = { [id:string]:User }
type Point = {x:number, y:number}
type ID = string

export type IJitsiConference={
  on: (eventType:string,callback:(...rest)=>void) => boolean
  addCommandListener: (command:string,callback:(e:any)=>void) => boolean
  sendCommand: (command:string,payload:any) => boolean
  join:()=>void
  addTrack:(track:Track)=>void
  myUserId:()=>ID
  leave:()=>void
}

type ConferenceStore = {
  conferenceObject?: IJitsiConference
  conferenceName: string|undefined
  isJoined: boolean
  users: Users
} & ConferenceActions & UserActions

type ConferenceActions = {
  init: () => void
  join: () => void
  leave: () => void
}

type UserActions = {
  calculateVolume: (id:ID) => void
  calculateVolumes: (localPos:Point) => void
}


// # IMPLEMENTATIONS *******************************************

export const useConferenceStore = create<ConferenceStore>((set,get) => {

  const initialState = {
    conferenceObject:undefined,
    conferenceName:"conference",
    isJoined:false,
    users:{},
  }

  const produceAndSet = (callback:(newState:ConferenceStore)=>void)=>set(state => produce(state, newState => callback(newState)))

  // Private Helper Functions *******************************************
  const _addUser = (id:ID) :void => produceAndSet (newState => {
    newState.users[id] = {id:id, mute:false, volume:1, pos:{x:0, y:0}}
  })
  const _removeUser = (id:ID) :void => produceAndSet (newState => {
    delete newState.users[id]
  })
  const _addAudioTrack = (id:ID, track:Track) => produceAndSet (newState => {
    if(newState.users[id]) newState.users[id].audio = track
  })
  const _removeAudioTrack = (id:ID):void => produceAndSet (newState => {
    if(newState.users[id]) newState.users[id].audio = undefined
  })
  const _addVideoTrack = (id:ID, track:Track):void => produceAndSet (newState => {
    if(newState.users[id]) newState.users[id].video = track
  })
  const _removeVideoTrack = (id:ID):void => produceAndSet (newState => {
    if(newState.users[id]) newState.users[id].video = undefined
  })
  const _onPositionReceived = (e:any):void => {
    const pos = JSON.parse(e.value)
    _updateUserPosition(pos.id, {x:pos.x, y:pos.y})
  }
  const _updateUserPosition = (id:ID, pos:Point):void => produceAndSet (newState => {
    if(newState.users[id]) newState.users[id]['pos'] = pos
  })
  const _onTrackMuteChanged = (track:Track):void => {
    if(track.getType() === 'video') return
    const tmpID = track.getParticipantId()
    set(state => produce(state, newState => {
      if(newState.users[tmpID]) newState.users[tmpID]['mute'] = track.isMuted() //check in beginning sucks
    }))
  }

  const _onRemoteTrackAdded = (track:Track):void => {
    if(track.isLocal()) return // also run on your own tracks so exit
    const JitsiMeetJS = useConnectionStore.getState().jsMeet 
    track.addEventListener(JitsiMeetJS?.events.track.LOCAL_TRACK_STOPPED,() => console.log('remote track stopped'))
    track.addEventListener(JitsiMeetJS?.events.track.TRACK_AUDIO_OUTPUT_CHANGED,deviceId =>console.log(`track audio output device was changed to ${deviceId}`))
    const id = track.getParticipantId() // get user id of track
    track.getType() === "audio" ? _addAudioTrack(id, track) : _addVideoTrack(id, track)
  }
  const _onRemoteTrackRemoved = (track:Track):void => {
    // TODO: Remove track from user Object
    const id = track.getParticipantId() // get user id of track
    track.getType() === 'audio' ? _removeAudioTrack(id) : _removeVideoTrack(id) // do we need that? maybe if user is still there but closes video?
    track.dispose()
  }

  // # Public functions *******************************************
  const init = ():void => {
    const JitsiMeetJS = useConnectionStore.getState().jsMeet 
    const connection = useConnectionStore.getState().connection //either move to ConnectionStore or handle undefined here
    const conferenceName = get().conferenceName || "conference"
    
    if(connection && JitsiMeetJS && conferenceName) {
      const conference = connection.initJitsiConference(conferenceName, conferenceOptions) //TODO before unload close connection
      conference.on(JitsiMeetJS.events.conference.USER_JOINED, _addUser)
      conference.on(JitsiMeetJS.events.conference.USER_LEFT, _removeUser)
      conference.on(JitsiMeetJS.events.conference.TRACK_ADDED, _onRemoteTrackAdded)
      conference.on(JitsiMeetJS.events.conference.TRACK_REMOVED, _onRemoteTrackRemoved)
      conference.on(JitsiMeetJS.events.conference.CONFERENCE_JOINED, () => set({isJoined:true})) //only Local User -> could be in LocalStore
      conference.on(JitsiMeetJS.events.conference.TRACK_MUTE_CHANGED, _onTrackMuteChanged);
      //conference.on(JitsiMeetJS.events.conference.DISPLAY_NAME_CHANGED, onUserNameChanged);
      // conference.on(JitsiMeetJS.events.conference.TRACK_AUDIO_LEVEL_CHANGED, on_remote_track_audio_level_changed);
      //conference.on(JitsiMeetJS.events.conference.PHONE_NUMBER_CHANGED, onPhoneNumberChanged);
      conference.addCommandListener("pos", _onPositionReceived)
      // r.on(JitsiMeetJS.events.conference.PARTICIPANT_PROPERTY_CHANGED, (e) => console.log("Property Changed ", e))
      window.addEventListener('beforeunload', leave) //does this help?  
      window.addEventListener('unload', leave) //does this help?  fdkshafdsk
      conference.join()
      set({conferenceObject:conference})
    } else {
      throw new Error('Jitsi Server connection has not been initialized or failed :( - did you call initJitsiMeet on ConnectionStore yet?')
    }
  }

  const join = () => {

  }
  const leave = () => { 
    const conference = get().conferenceObject
    conference?.leave()
  }
  const calculateVolume = (id:ID):void => produceAndSet (newState => {
    const localUserPosition:Point = useLocalStore.getState().pos //check if this is updated or kept by closure
    newState.users[id]['volume'] = getVolumeByDistance(localUserPosition, newState.users[id]['pos'])
  })
  const calculateVolumes = (localPos:Point) => produceAndSet (newState => {
    const users = newState.users
    Object.keys(users).map(key => {
      const user = users[key]
      newState.users[key]['volume'] = getVolumeByDistance(localPos, user.pos)
      return null
    })
  })
  // Return Object *******************************************
  return {
    ...initialState,
    init,
    join,
    leave,
    calculateVolume,
    calculateVolumes
  }
})

if(process.env.NODE_ENV === 'development') {
	mountStoreDevtool('ConferenceStore', useConferenceStore)
}