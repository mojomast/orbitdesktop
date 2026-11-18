// One fair queue per trusted Orbit window. Carries only ephemeral identities,
// never a credential, document, report or callback into a pane.
export function reportTurns(period:number) {
  const waiting=new Map<symbol,number>(); let next=-Infinity;
  return {
    leave(key:symbol){waiting.delete(key);},
    delay(key:symbol,now:number){
      for(const [k,seen] of waiting)if(now-seen>2*period)waiting.delete(k);
      waiting.set(key,now); // Updating a value keeps its original insertion order.
      if(now<next)return Math.ceil(next-now);
      if(waiting.keys().next().value!==key)return 500;
      waiting.delete(key);next=now+period;return 0;
    }
  };
}
