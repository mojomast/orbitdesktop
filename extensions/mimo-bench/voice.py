"""Bounded non-streaming audio calls; no input audio persisted or remote URLs accepted."""
import base64, io, json, time, urllib.request, urllib.error, wave, threading
MODELS=['mimo-v2.5-tts','mimo-v2.5-tts-voicedesign','mimo-v2.5-tts-voiceclone','mimo-v2.5-asr']
GATE=threading.Lock()
def payload(d):
    if not isinstance(d,dict) or set(d)-{'model','text','style','voice','audio','language','consent','rights'}:raise ValueError('Invalid fields')
    model=d.get('model')
    if model not in MODELS or d.get('consent') is not True:raise ValueError('Authorize paid API calls and data transmission')
    text=d.get('text','');style=d.get('style','')
    if not isinstance(text,str) or len(text)>1500 or not isinstance(style,str) or len(style)>1500:raise ValueError('Text and style limited to 1500 characters')
    audio=d.get('audio','')
    if model in (MODELS[2],MODELS[3]):
        if not isinstance(audio,str) or len(audio)>8_000_000:raise ValueError('Audio too large (6 MB decoded maximum)')
        prefix,sep,data=audio.partition(',')
        if prefix not in ('data:audio/wav;base64','data:audio/mpeg;base64') or not sep:raise ValueError('Upload WAV or MP3 audio')
        try:raw=base64.b64decode(data,validate=True)
        except Exception:raise ValueError('Invalid audio encoding')
        if not raw or len(raw)>6_000_000:raise ValueError('Invalid audio size')
        if prefix.startswith('data:audio/wav'):
            try:
                with wave.open(io.BytesIO(raw)) as w:
                    if w.getnframes()/w.getframerate()>120:raise ValueError('Audio limited to 120 seconds')
            except (wave.Error,EOFError):raise ValueError('Invalid PCM WAV')
        elif not (raw.startswith(b'ID3') or (raw[0]==255 and len(raw)>1 and raw[1]&224==224)):raise ValueError('Invalid MP3')
    if model==MODELS[3]:
        lang=d.get('language','auto')
        if lang not in ('auto','en','zh'):raise ValueError('Invalid language')
        return {'model':model,'messages':[{'role':'user','content':[{'type':'input_audio','input_audio':{'data':audio}}]}],'asr_options':{'language':lang},'stream':False}
    if not text.strip():raise ValueError('Enter text to speak')
    out={'format':'wav'}
    if model==MODELS[0]:
        voice=d.get('voice','Chloe')
        if not isinstance(voice,str) or not voice.isalnum() or len(voice)>64:raise ValueError('Invalid built-in voice ID')
        out['voice']=voice
    elif model==MODELS[1]:
        if not style.strip():raise ValueError('Describe the voice to design')
    else:
        if d.get('rights') is not True:raise ValueError('Confirm permission to clone this voice')
        out['voice']=audio
    return {'model':model,'messages':[{'role':'user','content':style},{'role':'assistant','content':text}],'audio':out,'stream':False}
def call(body,key,opener):
    start=time.perf_counter()
    req=urllib.request.Request('https://api.xiaomimimo.com/v1/chat/completions',data=json.dumps(body).encode(),headers={'api-key':key,'Content-Type':'application/json'})
    with opener.open(req,timeout=120) as r:
        raw=r.read(24_000_001)
    if len(raw)>24_000_000:raise ValueError('Provider response exceeded limit')
    data=json.loads(raw);message=data['choices'][0]['message']
    result={'model':body['model'],'elapsed_ms':round((time.perf_counter()-start)*1000,2),'usage':data.get('usage'),'text':message.get('content') or ''}
    if body['model']!=MODELS[3]:
        audio=base64.b64decode(message['audio']['data'],validate=True)
        with wave.open(io.BytesIO(audio)) as w:duration=w.getnframes()/w.getframerate()
        result.update(audio=base64.b64encode(audio).decode(),duration_seconds=duration,real_time_factor=result['elapsed_ms']/1000/duration if duration else None)
    return result
