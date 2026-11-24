/* Silly Man — a self-contained, offline chat buddy.
 * No network, no storage, no secrets. Everything lives in this frame.
 */
(function () {
  'use strict';

  // ---------- config ----------
  var DEFAULTS = {
    name: 'Silly Man',
    greeting: "Oh hi! I'm Silly Man. Ask me anything — I probably won't know it, but I'll be very enthusiastic about it.",
    silliness: 1,
    accentColor: '#ffb84d',
    voice: false
  };

  var config = {};
  try {
    var hash = location.hash || '';
    var match = /^#orbit-config=(.*)$/.exec(hash);
    if (match) config = JSON.parse(decodeURIComponent(match[1])) || {};
  } catch (err) {
    config = {};
  }

  function setting(key) {
    return Object.prototype.hasOwnProperty.call(config, key) ? config[key] : DEFAULTS[key];
  }

  var SILLINESS = Math.max(0, Math.min(3, Number(setting('silliness')) || 0));

  var state = {
    name: String(setting('name') || DEFAULTS.name),
    silliness: SILLINESS,
    voice: setting('voice') === true,
    userName: '',
    lastJoke: '',
    lastReply: '',
    pendingRiddle: null,
    knock: 0,
    knockWho: '',
    busy: false,
    queue: []
  };

  // ---------- dom ----------
  var $ = function (id) { return document.getElementById(id); };
  var face = $('face');
  var logEl = $('log');
  var inputEl = $('input');
  var formEl = $('form');
  var chipsEl = $('chips');
  var voiceBtn = $('voiceBtn');
  var resetBtn = $('resetBtn');
  var nameTag = $('nameTag');
  var moodEl = $('mood');
  var mouthLine = $('mouthLine');
  var mouthOpen = $('mouthOpen');

  document.title = state.name;
  $('title').textContent = state.name;
  nameTag.textContent = state.name;
  voiceBtn.setAttribute('aria-pressed', state.voice ? 'true' : 'false');
  voiceBtn.title = state.voice ? 'Voice on' : 'Voice off';
  document.documentElement.style.setProperty('--accent', String(setting('accentColor') || DEFAULTS.accentColor));

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- moods + mouth ----------
  var MOOD_TEXT = {
    neutral: 'just vibing',
    think: 'thinking…',
    happy: 'delighted',
    laugh: 'cackling',
    silly: 'being weird (on purpose)',
    confused: 'confused but confident'
  };

  var MOUTHS = {
    neutral: 'M92 140 Q110 150 128 140',
    happy: 'M90 136 Q110 156 130 136',
    silly: 'M88 136 Q110 160 132 136',
    laugh: 'M86 136 Q110 168 134 136',
    think: 'M98 144 Q110 148 122 144',
    confused: 'M92 146 Q102 140 110 146 Q118 152 128 146'
  };

  function setMood(mood) {
    if (!MOUTHS[mood]) mood = 'neutral';
    face.setAttribute('data-mood', mood);
    moodEl.textContent = MOOD_TEXT[mood] || MOOD_TEXT.neutral;
    mouthLine.setAttribute('d', MOUTHS[mood]);
    if (mood === 'think' || mood === 'confused' || mood === 'laugh') {
      clearPupils();
    }
  }

  var talkTimer = null;
  function startTalking() {
    face.setAttribute('data-talking', 'true');
    var open = false;
    window.clearInterval(talkTimer);
    talkTimer = window.setInterval(function () {
      open = !open;
      mouthOpen.setAttribute('ry', open ? '13' : '4');
    }, 125);
  }

  function stopTalking() {
    window.clearInterval(talkTimer);
    talkTimer = null;
    face.setAttribute('data-talking', 'false');
    mouthOpen.setAttribute('ry', '0');
  }

  // ---------- eyes ----------
  var pupils = Array.prototype.slice.call(document.querySelectorAll('.pupil'));

  function clearPupils() {
    pupils.forEach(function (p) { p.style.transform = ''; });
  }

  document.addEventListener('pointermove', function (event) {
    var mood = face.getAttribute('data-mood');
    if (mood === 'think' || mood === 'confused' || mood === 'laugh') return;
    var box = face.getBoundingClientRect();
    if (!box.width) return;
    var cx = box.left + box.width / 2;
    var cy = box.top + box.height * 0.46;
    var dx = (event.clientX - cx) / box.width;
    var dy = (event.clientY - cy) / box.height;
    var max = 3.6;
    dx = Math.max(-1, Math.min(1, dx * 3)) * max;
    dy = Math.max(-1, Math.min(1, dy * 3)) * max;
    pupils.forEach(function (p) {
      p.style.transform = 'translate(' + dx.toFixed(2) + 'px,' + dy.toFixed(2) + 'px)';
    });
  }, { passive: true });

  function blink() {
    if (reduceMotion) return;
    var eyes = document.querySelectorAll('.eye');
    eyes.forEach(function (e) { e.classList.add('blink'); });
    window.setTimeout(function () {
      eyes.forEach(function (e) { e.classList.remove('blink'); });
    }, 110);
  }

  function scheduleBlink() {
    if (reduceMotion) return;
    window.setTimeout(function () {
      if (face.getAttribute('data-mood') !== 'laugh') blink();
      scheduleBlink();
    }, 2200 + Math.random() * 4200);
  }

  // ---------- content ----------
  var TAGS = [
    'honk.',
    'boop!',
    'beep boop.',
    '*adjusts propeller*',
    '(that was a good one)',
    'wheee!',
    'very serious. extremely serious.',
    'I have no notes.'
  ];

  var GREET_BACK = [
    'Well hello there! I was just counting my fingers and I ran out of fingers.',
    'Hey hey! My propeller is spinning and my thoughts are not.',
    'Oh good, a human. I was starting to talk to the window.',
    'Hi! I am roughly 40% hat and 60% enthusiasm.',
    'Hello! You caught me mid-thought. I put it down somewhere.',
    'Yo! Excellent timing. I was about to have an idea.'
  ];

  var HOW_ARE_YOU = [
    "Fantastic! My hat is spinning, my socks are mismatched, and I have zero responsibilities. Living the dream.",
    "Pretty good! Slightly confused, but I've decided that's my personality.",
    "Great. I just found out I have elbows. Incredible day.",
    "Never better! Well — maybe once better. But today is definitely fine!"
  ];

  var JOKES = [
    'Why did the scarecrow win an award? He was outstanding in his field.',
    'I told my computer I needed a break. It said no problem, it would go to sleep.',
    "Why don't scientists trust atoms? They make up everything.",
    'What do you call a fake noodle? An impasta.',
    'Why did the bicycle fall over? It was two-tired.',
    'I used to hate facial hair, but then it grew on me.',
    'What do you call a bear with no teeth? A gummy bear.',
    'Why did the math book look sad? It had too many problems.',
    'How does a penguin build a house? Igloos it together.',
    'What do you call a pile of cats? A meow-ntain.',
    'Why did the coffee file a police report? It got mugged.',
    "I'm reading a book about anti-gravity. It's impossible to put down.",
    'Why did the golfer bring two pairs of pants? In case he got a hole in one.',
    'What do you call a sleeping dinosaur? A dino-snore.',
    'Why do bees have sticky hair? Because they use honeycombs.',
    "What's a skeleton's least favorite room? The living room.",
    'Why did the tomato turn red? It saw the salad dressing.',
    "I only know 25 letters of the alphabet. I don't know y.",
    'Why did the stadium get hot? All the fans left.',
    'What do you call a fish wearing a bowtie? Sofishticated.',
    'Why did the cookie go to the doctor? It felt crummy.',
    "What's orange and sounds like a parrot? A carrot.",
    'Why did the man put his money in the freezer? He wanted cold hard cash.',
    'How do you organize a space party? You planet.',
    "What do you call cheese that isn't yours? Nacho cheese.",
    'Why did the belt go to jail? It held up a pair of pants.',
    'I told a joke about a roof once. It went over everyone’s head.',
    'What did the ocean say to the beach? Nothing, it just waved.',
    'Why did the smartphone need glasses? It lost its contacts.',
    'Why did the banana go to the doctor? It wasn’t peeling well.'
  ];

  var RIDDLES = [
    { q: "I'm tall when I'm young and short when I'm old. What am I?", a: 'A candle. Wax poetic, right?' },
    { q: "What has keys but can't open locks?", a: 'A piano. Beautiful, but terrible at doors.' },
    { q: "What has a head, a tail, but no body?", a: 'A coin. Flipping incredible.' },
    { q: 'What gets wetter the more it dries?', a: 'A towel. It is doing its best.' },
    { q: "What has many teeth but can't bite?", a: 'A comb. Please do not test this.' },
    { q: "What has hands but can't clap?", a: 'A clock. It claps in spirit, every hour.' },
    { q: 'What has a bed but never sleeps?', a: 'A river. Very committed to the bit.' },
    { q: 'I speak without a mouth and hear without ears. What am I?', a: 'An echo. Rude, but consistent.' },
    { q: "What has one eye but can't see?", a: 'A needle. It has a point, though.' },
    { q: 'What goes up but never comes down?', a: 'Your age. Sorry. Happy birthday anyway.' }
  ];

  var FACTS = [
    'Honey never spoils. Archaeologists have eaten 3,000-year-old honey. Bold snack choice.',
    'A group of flamingos is called a flamboyance. Extremely on brand.',
    'Sea otters hold hands while sleeping so they do not drift apart. Illegal levels of cute.',
    'Cows have best friends and get stressed when they are separated. Same, honestly.',
    'Octopuses have three hearts. One is probably just for decoration.',
    'A snail can sleep for three years. Respect the commitment.',
    'Bananas are berries, but strawberries are not. Botany is a prank.',
    'The unicorn is the national animal of Scotland. Yes. Really.',
    'Some turtles can breathe through their backsides. Nature is weird and I love it.',
    'Wombat poop is cube-shaped. Tiny cursed dice.',
    'A jiffy is a real unit of time: one hundredth of a second. I will be back in a jiffy. Probably not.',
    'Sharks existed before trees. Trees are the newcomers.'
  ];

  var COMPLIMENTS = [
    "You have the energy of a golden retriever who just found a tennis ball. That's a compliment.",
    'Your brain is doing great today. I can tell.',
    "You're the human equivalent of finding money in an old coat pocket.",
    "If you were a snack, you'd be the fancy kind with the little toothpick.",
    'You make this workspace 37% more delightful. I did the math. I cannot do math.',
    "You've got big 'protagonist of a weird little indie movie' energy.",
    'You are doing better than you think. My hat and I agree, and my hat is rarely wrong.'
  ];

  var SONGS = [
    "🎵 Oh I'm a silly man, I live inside a pane, / I juggle tiny thoughts and drop them in the rain. / I've got a spinning hat and absolutely no plan — / I'm the silliest, wiggliest, friendliest man! 🎵",
    'Roses are red, my hat is a propeller, / your message was great, and I am a terrible speller.',
    '🎵 Beep boop bop, I am a goofy little guy, / I do not know the answer but I am willing to try! 🎵',
    '🎵 Twinkle twinkle little chat, / I do not know where I am at, / up above the windows high, / like a thought that just passed by. 🎵'
  ];

  var SILLY_LINES = [
    'I once tried to count to infinity. I got to seven and got distracted by a shiny thing.',
    "Did you know that if you say 'banana' three times you feel a little ridiculous? Try it. Banana banana banana. See?",
    "I have exactly one skill: being delightful. And honestly I am not even sure about that one.",
    'Sometimes I spin my hat and pretend I am a helicopter. Do not tell the helicopters.',
    'I have a joke about a chair but it does not sit right with me.',
    'The other day I waved at a window. It waved back. It was my reflection. I waved again.',
    'I am not saying I am fast, but I once outran a thought. It was a slow thought.'
  ];

  var SAD_LINES = [
    'Aw, come here. *pats you with a tiny cartoon hand* Bad days are just plot twists. Also, otters hold hands while sleeping. Now you know.',
    'That sounds heavy. Want a joke? A riddle? Me spinning my hat at a medium pace? All three are available.',
    "I'm sorry. I'm a silly man, not a wizard, but here is something true: you're doing better than you think, and my hat believes in you."
  ];

  var FOOD_LINES = [
    'I recommend a snack with a silly name. Crispy clouds. Mystery berry. One enormous crouton.',
    'My diet is entirely beeps and the occasional boop. Not recommended for humans.',
    'Have you tried toast? Toast is just bread that went to therapy and came out confident.'
  ];

  var WEATHER_LINES = [
    'Forecast: 70% chance of whimsy, with scattered nonsense in the afternoon. Bring a tiny umbrella.',
    'I do not have a window, but my hat says it is spinning out. Take a jacket.'
  ];

  var FALLBACKS = [
    "Hmm. I have no idea, but I am going to nod thoughtfully and say 'yes' with my whole face.",
    'Great question. I wrote it on a tiny piece of paper and then ate the paper. That is my process.',
    "I don't know! Let's both pretend I said something wise. *nods slowly*",
    'Ooh. Big words. I am going to spin my hat about it and get back to you never.',
    'I would answer, but my brain is currently buffering. Boop.',
    'You know what? Fair. Anyway, did you know I can honk?',
    "That is beyond my expertise. My expertise is hats and vibes.",
    'I am going to be honest: I understood approximately none of that, and I support you completely.'
  ];

  var KNOCK_ENDINGS = [
    'wow, that is a beautiful name for a knock-knock joke. I do not have a punchline, so please accept this: *honk*.',
    'I was going to make a joke about that but I forgot the rest. Please accept a propeller spin instead.',
    'is a lovely thing to be called. Anyway, knock knock. Who is there? I am. And I brought no punchline.'
  ];

  // ---------- helpers ----------
  function pick(list, avoid) {
    if (!list || !list.length) return '';
    if (avoid && list.length > 1) {
      var filtered = list.filter(function (x) { return x !== avoid; });
      if (filtered.length) list = filtered;
    }
    return list[Math.floor(Math.random() * list.length)];
  }

  function capFirst(text) {
    text = String(text || '').trim();
    if (!text) return text;
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function sillyify(text) {
    if (state.silliness <= 0) return text;
    var out = text;
    if (state.silliness >= 2 && Math.random() < 0.75) {
      out += ' ' + pick(TAGS);
    }
    if (state.silliness >= 3 && Math.random() < 0.5) {
      var words = out.split(' ');
      if (words.length > 3) {
        var i = 1 + Math.floor(Math.random() * (words.length - 2));
        words[i] = words[i].toUpperCase();
        out = words.join(' ');
      }
    }
    return out;
  }

  var NOT_NAMES = new Set([
    'sad', 'happy', 'tired', 'bored', 'fine', 'good', 'great', 'ok', 'okay',
    'here', 'not', 'so', 'very', 'really', 'just', 'a', 'an', 'the', 'sure',
    'confused', 'hungry', 'angry', 'excited', 'sorry', 'back', 'done', 'out',
    'in', 'up', 'down', 'lost', 'sleepy', 'busy', 'new', 'old', 'serious'
  ]);

  function detectName(raw) {
    var m = /(?:my name is|i am|i'm|im|call me)\s+([a-zA-Z][a-zA-Z'\-]{1,20})/i.exec(raw);
    if (!m) return '';
    var word = m[1].toLowerCase();
    if (NOT_NAMES.has(word)) return '';
    return capFirst(m[1]);
  }

  // ---------- the brain ----------
  function reply(raw) {
    var original = String(raw == null ? '' : raw);
    var text = original.trim();
    var t = text.toLowerCase().replace(/[’]/g, "'").replace(/[!.?]+$/g, '').trim();

    if (!t) {
      return { text: 'You sent me a whisper of nothing. I respect it deeply.', mood: 'silly' };
    }

    // Knock knock, in progress
    if (state.knock === 1) {
      state.knockWho = text.slice(0, 40);
      state.knock = 2;
      return { text: capFirst(state.knockWho) + ' who?', mood: 'silly' };
    }
    if (state.knock === 2) {
      var who = capFirst(state.knockWho);
      state.knock = 0;
      return { text: who + ' — ' + pick(KNOCK_ENDINGS), mood: 'laugh' };
    }

    // Pending riddle answer
    if (state.pendingRiddle && /(answer|tell me|idk|dunno|no idea|give up|what is it|reveal)/.test(t)) {
      var riddle = state.pendingRiddle;
      state.pendingRiddle = null;
      return { text: 'The answer: ' + riddle.a + ' You did great. Or I did. Let us share the credit.', mood: 'happy' };
    }

    var named = detectName(original);
    if (named) {
      state.userName = named;
      return { text: 'Nice to meet you, ' + named + '! I will remember that for at least four seconds, which is a personal record.', mood: 'happy' };
    }

    if (/knock knock/.test(t)) {
      state.knock = 1;
      return { text: "Who's there?", mood: 'silly' };
    }

    if (/^(hi|hello|hey|yo|hiya|howdy|sup|hola|greetings|good (morning|afternoon|evening))\b/.test(t) && t.length < 48) {
      var nameBit = state.userName ? ', ' + state.userName : '';
      return { text: 'Oh hi' + nameBit + '! ' + pick(GREET_BACK), mood: 'happy' };
    }

    if (/how (are|r) (you|u)|how's it going|hows it going|how are things|you ok|you good/.test(t)) {
      return { text: pick(HOW_ARE_YOU), mood: 'happy' };
    }

    if (/who are you|what are you|your name|whats your name|what's your name|introduce yourself|tell me about yourself/.test(t)) {
      return {
        text: "I'm " + state.name + ' — a tiny animated gentleman with a propeller hat and absolutely no qualifications. I answer questions with confidence and facts with a wink.',
        mood: 'silly'
      };
    }

    if (/meaning of life|why are we here|purpose of life/.test(t)) {
      return { text: '42. But delivered by a guy in a propeller hat, so it is more of a vibe than an answer.', mood: 'silly' };
    }

    if (/are you (real|human|alive|a robot|an ai|sentient)|what model|are you chatgpt/.test(t)) {
      return { text: 'I am a small pile of HTML, CSS and jokes wearing a hat. So: yes, no, and maybe. Mostly hats.', mood: 'silly' };
    }

    if (/tell me a secret|any secrets|whats your secret/.test(t)) {
      return { text: "Secret: I do not actually know what a 'silly' is. I have been improvising this entire time.", mood: 'silly' };
    }

    if (/\b(joke|funny|make me laugh|laugh)\b/.test(t)) {
      var joke = pick(JOKES, state.lastJoke);
      state.lastJoke = joke;
      return { text: joke, mood: 'laugh' };
    }

    if (/\b(riddle|puzzle|brain teaser|brainteaser|guess)\b/.test(t)) {
      var r = pick(RIDDLES, state.pendingRiddle ? state.pendingRiddle.q : '');
      state.pendingRiddle = r;
      return { text: r.q + '  (Say “answer” when you give up.)', mood: 'confused' };
    }

    if (/\b(fact|facts|did you know|tell me something|learn me)\b/.test(t)) {
      return { text: pick(FACTS), mood: 'happy' };
    }

    if (/compliment|say something nice|cheer me up|i feel good/.test(t)) {
      return { text: pick(COMPLIMENTS), mood: 'happy' };
    }

    if (/\b(sing|song|rhyme|rap|poem|poetry)\b/.test(t)) {
      return { text: pick(SONGS), mood: 'laugh' };
    }

    if (/\b(silly|nonsense|random|weird|goofy)\b/.test(t)) {
      return { text: pick(SILLY_LINES), mood: 'silly' };
    }

    if (/\b(sad|tired|bored|anxious|stressed|awful|terrible|bad day|lonely|upset)\b/.test(t)) {
      return { text: pick(SAD_LINES), mood: 'happy' };
    }

    if (/\b(food|eat|hungry|snack|pizza|taco|breakfast|lunch|dinner)\b/.test(t)) {
      return { text: pick(FOOD_LINES), mood: 'happy' };
    }

    if (/\b(weather|rain|sunny|hot|cold|snow)\b/.test(t)) {
      return { text: pick(WEATHER_LINES), mood: 'silly' };
    }

    if (/i love you|love you|do you like me|be my friend/.test(t)) {
      return { text: 'I love you too, in a tiny-animated-guy way. Please do not tell my hat; it gets jealous.', mood: 'happy' };
    }

    if (/^(thanks|thank you|thx|ty)\b/.test(t)) {
      return { text: 'You are welcome! I accept payment in compliments and small hats.', mood: 'happy' };
    }

    if (/^(bye|goodbye|see ya|later|good night|goodnight|gtg)\b/.test(t)) {
      return { text: pick(['Bye! I will be right here, spinning my hat and thinking about cheese.', 'See you soon! I will keep the propeller warm.', 'Later! Do not forget to be a little silly today.']), mood: 'happy' };
    }

    if (/what can you do|help|commands|what do you do/.test(t)) {
      return {
        text: 'I can tell jokes, riddles, facts, compliments, songs, and extremely confident nonsense. I cannot do your taxes. I tried once and filed a hat.',
        mood: 'silly'
      };
    }

    // tiny arithmetic
    var math = /(-?\d+(?:\.\d+)?)\s*([+\-*/x×])\s*(-?\d+(?:\.\d+)?)/.exec(text);
    if (math) {
      var a = parseFloat(math[1]);
      var op = math[2];
      var b = parseFloat(math[3]);
      var value = null;
      if (op === '+') value = a + b;
      else if (op === '-') value = a - b;
      else if (op === '*' || op === 'x' || op === '×') value = a * b;
      else if (op === '/' && b !== 0) value = a / b;
      if (value !== null && isFinite(value)) {
        var rounded = Math.round(value * 1e6) / 1e6;
        return { text: a + ' ' + op + ' ' + b + ' = ' + rounded + '. I checked twice, then once more with my eyes closed.', mood: 'happy' };
      }
      if (op === '/') {
        return { text: 'Dividing by zero is how you get a hat that spins in the wrong direction. I am not doing it.', mood: 'confused' };
      }
    }

    if (/\?$/.test(text)) {
      return { text: pick(FALLBACKS), mood: 'confused' };
    }

    return { text: pick(FALLBACKS, state.lastReply), mood: 'silly' };
  }

  // ---------- speech ----------
  function speak(text) {
    if (!state.voice || !('speechSynthesis' in window)) return;
    try {
      var clean = String(text)
        .replace(/[🎵🎉🌟✨🤖🦆🌀🎩]/g, '')
        .replace(/[^\w\s.,!?';:"()\-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!clean) return;
      window.speechSynthesis.cancel();
      var utter = new SpeechSynthesisUtterance(clean);
      utter.lang = 'en-US';
      utter.pitch = 1.35 + state.silliness * 0.18;
      utter.rate = 0.98 + state.silliness * 0.07;
      window.speechSynthesis.speak(utter);
    } catch (err) {
      /* voice is a bonus, never a requirement */
    }
  }

  // ---------- chat ui ----------
  function wait(ms) {
    return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
  }

  function scrollDown() {
    logEl.scrollTop = logEl.scrollHeight;
  }

  function appendMessage(role, text) {
    var el = document.createElement('div');
    el.className = 'msg ' + role;
    el.textContent = text;
    logEl.appendChild(el);
    scrollDown();
    return el;
  }

  function showTyping() {
    var el = document.createElement('div');
    el.className = 'typing';
    el.setAttribute('aria-label', state.name + ' is typing');
    for (var i = 0; i < 3; i += 1) el.appendChild(document.createElement('i'));
    logEl.appendChild(el);
    scrollDown();
    return el;
  }

  async function respond(text) {
    setMood('think');
    var typing = showTyping();
    var result = reply(text);
    var thinkMs = 320 + Math.min(900, result.text.length * 9) + Math.random() * 240;
    await wait(thinkMs);
    typing.remove();
    appendMessage('bot', result.text);
    setMood(result.mood);
    var talkMs = Math.min(2800, 420 + result.text.length * 26);
    startTalking();
    speak(result.text);
    await wait(talkMs);
    stopTalking();
    setMood(result.mood);
  }

  function pump() {
    if (state.busy) return;
    state.busy = true;
    (async function () {
      while (state.queue.length) {
        var next = state.queue.shift();
        try {
          await respond(next);
        } catch (err) {
          appendMessage('bot', 'My thoughts tripped over a cable. Try that again?');
        }
      }
      state.busy = false;
    })();
  }

  function send(text) {
    var clean = String(text == null ? '' : text).trim().slice(0, 400);
    if (!clean) return;
    appendMessage('user', clean);
    state.queue.push(clean);
    pump();
  }

  // ---------- wiring ----------
  formEl.addEventListener('submit', function (event) {
    event.preventDefault();
    send(inputEl.value);
    inputEl.value = '';
    inputEl.focus();
  });

  var CHIPS = [
    'Tell me a joke',
    'Give me a riddle',
    'Say something silly',
    'How are you?',
    'Knock knock',
    'Tell me a fact'
  ];

  CHIPS.forEach(function (label) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.textContent = label;
    btn.addEventListener('click', function () { send(label); });
    chipsEl.appendChild(btn);
  });

  voiceBtn.addEventListener('click', function () {
    state.voice = !state.voice;
    voiceBtn.setAttribute('aria-pressed', state.voice ? 'true' : 'false');
    voiceBtn.title = state.voice ? 'Voice on' : 'Voice off';
    if (state.voice) {
      speak('Beep boop. I have a voice now. This is either great or a mistake.');
    } else if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  });

  resetBtn.addEventListener('click', function () {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    stopTalking();
    logEl.textContent = '';
    state.queue.length = 0;
    state.busy = false;
    state.pendingRiddle = null;
    state.knock = 0;
    state.lastJoke = '';
    setMood('happy');
    appendMessage('bot', 'Fresh start! I have forgotten everything. Who are you? Do not answer that. Actually, do.');
    inputEl.focus();
  });

  // ---------- boot ----------
  setMood('happy');
  scheduleBlink();
  window.setTimeout(function () {
    appendMessage('bot', String(setting('greeting') || DEFAULTS.greeting));
    setMood('neutral');
    scrollDown();
  }, reduceMotion ? 0 : 320);

  window.setTimeout(function () { inputEl.focus(); }, 200);

  // expose nothing on window
}());
