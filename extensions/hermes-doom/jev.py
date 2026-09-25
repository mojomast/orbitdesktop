"""Bounded typed decisions. No credentials from environment or disk."""
import json, math, threading, time, urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Provider redirect rejected')

def request(payload, key):
    req = urllib.request.Request('https://api.typesafe.ai/v1/systemone', data=json.dumps(payload, allow_nan=False).encode(), headers={'Content-Type':'application/json', 'Authorization':'Bearer '+key})
    with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(req, timeout=5) as response:
        raw=response.read(65537)
    if len(raw)>65536: raise ValueError('Oversized provider response')
    return json.loads(raw)

def payload_for(observation, actions):
    return {'model':'jev-latest','state':observation,'questions':{'action':{'type':'choice','instructions':'Choose the next short Doom action to survive, aim at visible enemies, collect needed supplies, explore and reach the exit. Screen x increases rightward; depth is near=0 far=255. Avoid blocked corridors; use doors when stuck. Pick only an available action.','criteria':{k:' + '.join(v) for k,v in actions.items()}}}}

def validate(data, actions):
    answer=data['answers']['action']
    choice=answer['choice']; confidence=answer['confidence']; probabilities=answer['probabilities']
    number=lambda v:type(v) in (float,int) and math.isfinite(v) and 0<=v<=1
    if answer.get('type')!='choice' or choice not in actions or not number(confidence): raise ValueError('Invalid choice')
    if not isinstance(probabilities,dict) or set(probabilities)!=set(actions) or not all(number(v) for v in probabilities.values()) or abs(sum(probabilities.values())-1)>0.02: raise ValueError('Invalid distribution')
    if probabilities[choice] < max(probabilities.values()): raise ValueError('Choice inconsistent with distribution')
    return choice, confidence

class Controller:
    def __init__(self, transport=request):
        self.lock=threading.Lock(); self.transport=transport; self.key=''; self.generation=0
        self.deadline=0; self.remaining=0; self.last_call=0
        self.metrics={'mode':'local','calls':0,'accepted':0,'fallbacks':0,'errors':0,'last_ms':0,'confidence':None,'source':'local','message':'Local frozen policy; Jev disabled','input_tokens':0,'output_tokens':0}
    def enable(self, key, consent, budget):
        if consent is not True or not isinstance(key,str) or not 8<=len(key)<=512 or any(ord(c)<33 or ord(c)>126 for c in key): raise ValueError('Key and explicit consent required')
        if type(budget)!=int or not 1<=budget<=100: raise ValueError('Budget must be 1–100 calls')
        with self.lock:
            self.key=key; self.remaining=budget; self.generation+=1; self.deadline=time.monotonic()+120
            self.metrics.update(mode='jev',message='Jev armed: 120-second maximum session')
    def disable(self, message='Jev stopped; key cleared'):
        with self.lock:
            self.key=''; self.remaining=0; self.generation+=1; self.metrics.update(mode='local',message=message)
    def snapshot(self):
        with self.lock:
            if self.key and time.monotonic() >= self.deadline:
                self.key=''; self.remaining=0; self.generation+=1; self.metrics.update(mode='local',message='Jev session expired; key cleared')
            return dict(self.metrics,remaining=self.remaining)
    def choose(self, observation, actions, fallback):
        before=self.snapshot(); started=time.monotonic()
        choice=self._choose(observation, actions, fallback)
        with self.lock:
            after=self.metrics
            requested=after['calls']>before['calls']
            source=after['source'] if requested else 'local'
            event={'id':getattr(self,'sequence',0)+1,'source':source,'requested':requested,'action':choice,'fallback':fallback,'confidence':after['confidence'] if requested else None,'ms':round((time.monotonic()-started)*1000,1),'reason':after['message'] if requested else 'Local frozen policy / request rate gate','health':observation.get('health'),'ammo':observation.get('ammo')}
            self.sequence=event['id']
            self.history=(getattr(self,'history',[])+[event])[-60:]
        return choice

    def decisions(self):
        with self.lock:return list(getattr(self,'history',[]))

    def _choose(self, observation, actions, fallback):
        with self.lock:
            now=time.monotonic()
            if self.key and (now>=self.deadline or self.remaining<=0):
                self.key=''; self.generation+=1; self.metrics.update(mode='local',message='Jev budget/session expired; local policy')
            if not self.key or now-self.last_call<0.25:
                self.metrics['source']='local'; return fallback
            key=self.key; generation=self.generation; self.remaining-=1; self.last_call=now; self.metrics['calls']+=1; self.metrics['confidence']=None; self.metrics['source']='local'
        try:
            result=self.transport(payload_for(observation,actions),key)
            choice,confidence=validate(result,actions)
            with self.lock:
                if generation!=self.generation:
                    self.metrics.update(source='local',confidence=None,message='In-flight result discarded after stop')
                    return fallback
                self.metrics.update(last_ms=round((time.monotonic()-now)*1000,1),confidence=confidence)
                usage=result.get('usage',{})
                for field in ('input_tokens','output_tokens'):
                    v=usage.get(field,0)
                    if type(v)==int and 0<=v<=1000000:self.metrics[field]+=v
                if confidence<0.65:
                    self.metrics['fallbacks']+=1; self.metrics.update(source='local',message='Low confidence; local fallback'); return fallback
                self.metrics['accepted']+=1; self.metrics.update(source='jev',message='Validated Jev decision',action=choice)
                return choice
        except Exception:
            with self.lock:
                if generation==self.generation:
                    self.key=''; self.remaining=0; self.generation+=1; self.metrics['errors']+=1; self.metrics['fallbacks']+=1
                    self.metrics.update(mode='local',source='local',message='Jev request failed or invalid response; stopped and key cleared',last_ms=round((time.monotonic()-now)*1000,1))
            return fallback
