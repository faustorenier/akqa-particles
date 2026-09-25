# Come funziona la demo

Questa guida è per chi conosce React ma non ha mai lavorato con WebGPU o con gli shader. Racconta il percorso completo: dalla pagina che si apre fino alle sfere che si muovono sullo schermo.

## In breve

- La parte di React esiste soltanto all'avvio. Serve a creare il canvas, la camera e le luci, e a montare un componente che prepara la simulazione.
- Le posizioni di partenza e di arrivo delle sfere vengono calcolate **una sola volta**, sulla CPU, in TypeScript normale.
- Da quel momento lo stato delle 10.000 sfere (posizione e velocità) vive **solo nella memoria della GPU**. A ogni frame alcuni piccoli programmi GPU, detti *compute shader*, aggiornano quello stato. Subito dopo lo shader di disegno lo legge direttamente da lì.
- A ogni frame la CPU invia solo pochi numeri: lo stato di avanzamento dello scroll, la posizione del mouse, il tempo e il `dt`. Non esiste un array di particelle in React, e a ogni frame non c'è nessuna lettura di dati dalla GPU.
- Tutti gli shader sono scritti in **TSL** (Three.js Shading Language): si scrivono in TypeScript e three li converte in WGSL, il linguaggio shader di WebGPU. Nel progetto non c'è WGSL scritto a mano.

```
avvio ─► checkWebGPU ─► <Canvas> + WebGPURenderer ─► buildParticles (CPU, una volta)
                                                        │
                                                        ▼
                                           createSimulation: buffer GPU + shader TSL
                                                        │
ogni frame (≤ 60 FPS) ──────────────────────────────────┘
  CPU: scroll → morph (molla), mouse → punto 3D, aggiorna uniform
  GPU: integrate → [clearGrid → binParticles → solveCollisions → commit] × 2 → render
```

## Mappa dei file

| File | Ruolo |
| --- | --- |
| [`src/main.tsx`](../src/main.tsx) | Punto d'ingresso React |
| [`src/App.tsx`](../src/App.tsx) | Controllo WebGPU, `<Canvas>`, luci, loop a 60 FPS, pausa, errori |
| [`src/createRenderer.ts`](../src/createRenderer.ts) | Crea il `WebGPURenderer` e impedisce che passi di nascosto a WebGL |
| [`src/glyphs.ts`](../src/glyphs.ts) | Lettere descritte come segmenti geometrici |
| [`src/sampleWord.ts`](../src/sampleWord.ts) | Riempie le lettere di sfere e abbina AKQA con WPP |
| [`src/simulation.ts`](../src/simulation.ts) | **Tutto il codice GPU**: buffer, compute shader, materiale |
| [`src/fluid.ts`](../src/fluid.ts) | Scia luminosa del puntatore: fumo simulato con un fluido 2D sulla GPU |
| [`src/Particles.tsx`](../src/Particles.tsx) | Collega scroll e mouse alla simulazione e la esegue a ogni frame |

---

## 1. Inizializzazione del mondo

### 1.1 Controllo di WebGPU prima di montare il canvas

[`App.tsx:64`](../src/App.tsx#L64) chiama `checkWebGPU()` ([`createRenderer.ts:6`](../src/createRenderer.ts#L6)). La funzione verifica che `navigator.gpu` esista e che `requestAdapter()` restituisca davvero una GPU. Se una delle due condizioni fallisce, il `<Canvas>` non viene montato e compare un messaggio d'errore.

### 1.2 Il renderer WebGPU dentro React Three Fiber

R3F crea di default un renderer WebGL. La prop `gl` del `<Canvas>` ([`App.tsx:93`](../src/App.tsx#L93)) gli passa invece una funzione **asincrona** che costruisce il renderer WebGPU ([`createRenderer.ts:17`](../src/createRenderer.ts#L17)):

```ts
const renderer = new WebGPURenderer({ ...props, antialias: true, powerPreference: 'high-performance' })
await renderer.init()                       // WebGPU si inizializza in modo asincrono
if (!renderer.backend.isWebGPUBackend) ...  // mostra un errore
renderer.onDeviceLost = ...                 // GPU persa → messaggio + tasto "Ricarica"
```

Il controllo su `isWebGPUBackend` è importante. Quando WebGPU non è disponibile, `WebGPURenderer` ripiega **in silenzio** su WebGL2: senza questo controllo la demo sembrerebbe funzionare, ma non sul backend dichiarato.

### 1.3 Canvas, camera e luci

Tutto è dichiarato in JSX, in [`App.tsx:88-107`](../src/App.tsx#L88):

- `frameloop="never"`: R3F non disegna da solo. Decidiamo noi quando disegnare (vedi §1.4).
- `dpr={[1, 1.5]}`: la densità di pixel è limitata a 1,5, per evitare di disegnare 4 volte i pixel su un Retina.
- Le luci sono tre: una emisferica tenue, una *key light* frontale e una *rim light* da dietro che fa risaltare il contorno delle sfere. Il fondo è nero.
- La camera è una prospettica con FOV 35°. La sua distanza viene ricalcolata a ogni resize, così la parola entra sempre nello schermo ([`Particles.tsx:57`](../src/Particles.tsx#L57)).

### 1.4 Il loop dei frame

`FrameDriver` ([`App.tsx:9`](../src/App.tsx#L9)) ha un suo `requestAnimationFrame` e chiama `advance()` di R3F al massimo 60 volte al secondo. Su un display ProMotion a 120 Hz salta un vblank su due. Si ferma quando la scheda è nascosta o la demo è in pausa. In pausa ridisegna un solo frame dopo un resize, perché il canvas non resti nero.

---

## 2. Creazione delle particelle (CPU, una sola volta)

La creazione avviene tutta in [`Particles.tsx:39`](../src/Particles.tsx#L39):

```ts
const sim = useMemo(() => createSimulation(buildParticles(COUNT)), [])
```

`buildParticles` prepara i dati in array tipizzati, mentre `createSimulation` li carica sulla GPU. Vediamo i due passaggi.

### 2.1 Le lettere sono segmenti

In [`glyphs.ts`](../src/glyphs.ts) non ci sono font. Ogni lettera è una lista di segmenti, cioè le **linee centrali** dei tratti, in uno spazio in cui l'altezza della lettera vale 1:

```ts
H: { width: 0.8, segments: [ [[I, bottom], [I, top]], [[0.8 - I, bottom], [0.8 - I, top]], [[I, 0.5], [0.8 - I, 0.5]] ] }
```

Le curve della R e della Q sono approssimate con piccoli segmenti tramite `arc()` ([`glyphs.ts:10`](../src/glyphs.ts#L10)). `wordSegments()` ([`glyphs.ts:84`](../src/glyphs.ts#L84)) mette le lettere in fila con la spaziatura `TRACKING`, centra la parola e la scala all'altezza in unità del mondo (`WORD_HEIGHT = 3.6`).

### 2.2 Riempire i tratti di sfere

Ogni tratto diventa un **tubo 3D** intorno al suo segmento: largo `STROKE × WORD_HEIGHT` e un po' più profondo lungo z (`Z_STRETCH`). Il riempimento lo fa `placeInWord()` ([`sampleWord.ts:50`](../src/sampleWord.ts#L50)):

1. **Raggi.** `buildParticles()` ([`sampleWord.ts:130`](../src/sampleWord.ts#L130)) genera N raggi casuali, con più sfere piccole che grandi, e li ordina dal più grande al più piccolo. Poi li scala in modo che le sfere occupino circa il 14% del volume dei tubi (`PACKING`, [`sampleWord.ts:139`](../src/sampleWord.ts#L139)). Ne segue che **aumentando il numero di particelle, le sfere diventano automaticamente più piccole**.
2. **Posizionamento.** Per ogni sfera, a partire dalla più grande, estrae fino a 60 punti candidati dentro il tubo e tiene quello che si sovrappone meno alle sfere già piazzate. Per trovare i vicini usa una griglia spaziale semplice su `Map`, così non deve confrontare ogni sfera con tutte le altre.
3. Il generatore casuale ha un seed fisso (`mulberry32`), quindi a ogni avvio la disposizione è identica.

### 2.3 Abbinare AKQA e WPP

Entrambe le parole vengono riempite con **la stessa lista di raggi**: così ogni sfera conserva la sua dimensione quando cambia parola. Resta da decidere quale posto di AKQA corrisponde a quale posto di WPP. Le sfere vengono divise in gruppi di raggio simile (`PAIR_BIN = 400`). Dentro ogni gruppo si ordinano le due parole da sinistra a destra e si abbinano per posizione in classifica. Il risultato è che una sfera della A iniziale finisce nella W e non dall'altra parte dello schermo.

Per ogni particella `buildParticles` produce tre `Float32Array` di vec4:

| Array | `xyz` | `w` |
| --- | --- | --- |
| `targetA` | posizione in AKQA | seed casuale (sfasa il rumore) |
| `targetB` | posizione in WPP | ritardo della transizione (onda da sinistra a destra, [`sampleWord.ts:171`](../src/sampleWord.ts#L171)) |
| `scatter` | direzione e ampiezza dell'"esplosione" a metà transizione, allungata lungo z | — |

A questi si aggiunge `radius`. Per 10.000 sfere la preparazione richiede circa 0,15 s.

---

## 3. Lo stato sulla GPU

[`createSimulation()`](../src/simulation.ts#L62) carica i dati in **storage buffer**, cioè array che vivono nella memoria della GPU e che gli shader possono leggere e scrivere. In TSL si creano con `instancedArray` ([`simulation.ts:80-89`](../src/simulation.ts#L80)):

| Buffer | Tipo | Contenuto |
| --- | --- | --- |
| `pos` | vec4 × N | `xyz` = posizione attuale, `w` = raggio |
| `posNext` | vec4 × N | posizione dopo la correzione delle collisioni (buffer di appoggio) |
| `vel` | vec4 × N | velocità |
| `targetA`, `targetB`, `scatter` | vec4 × N | i dati del §2.3, caricati una volta e mai modificati |
| `crowding` | float × N | numero di vicini, usato per l'ombreggiatura |
| `cellCount` | uint atomico × 32.768 | quante particelle ci sono in ogni cella della griglia |
| `cellSlots` | uint × 32.768 × 16 | indici delle particelle presenti in ogni cella |

Il raggio sta in `pos.w` perché lo shader delle collisioni legga posizione e raggio di un vicino con un'unica lettura. Si usa vec4 anziché vec3 perché ha un allineamento in memoria più semplice su WebGPU.

La CPU comunica con gli shader tramite gli **uniform** ([`simulation.ts:91-102`](../src/simulation.ts#L91)): `uMorph`, `uTime`, `uDt`, `uPointer`, `uPointerStrength`, `uScatter`, `uIdle` e i 16 punti della scia `uTrail`. Sono valori singoli, uguali per tutte le particelle, e da JavaScript si aggiornano con `uniform.value = ...`.

---

## 4. Gli shader (tutti in `src/simulation.ts`)

### 4.1 Come leggere il codice TSL

TSL assomiglia a TypeScript, ma **non viene eseguito in JavaScript**: le funzioni costruiscono un albero di nodi che three traduce in WGSL. Le corrispondenze principali:

| TSL | Significato |
| --- | --- |
| `Fn(() => { ... })` | definisce una funzione shader |
| `.compute(n)` | la trasforma in un compute shader eseguito `n` volte in parallelo |
| `instanceIndex` | l'indice del thread, cioè "quale particella sto elaborando" |
| `pos.element(instanceIndex)` | `pos[i]` |
| `a.add(b)`, `.mul()`, `.sub()`, `.div()` | `+ * - /`: gli operatori JS non funzionano sui nodi |
| `.toVar()` | salva il valore in una variabile dello shader, per non ricalcolarlo |
| `.assign(v)`, `.addAssign(v)` | `=` e `+=` su buffer o variabili |
| `If(cond, () => {...})`, `Loop(...)` | `if` e `for` **dentro lo shader** |
| `uniform(x)` | un valore che la CPU può cambiare a ogni frame |

Una cosa da tenere a mente: in TSL un numero JS scritto senza wrapper viene trattato come `float`. Nei calcoli con interi il codice usa quindi `int(3)`, `uint(16)` e `ivec3(...)` in modo esplicito.

### 4.2 Le passate di calcolo a ogni frame

In [`simulation.ts:218`](../src/simulation.ts#L218) le passate vengono messe in sequenza e poi eseguite tutte da `sim.step()` con una sola `renderer.compute(passes)`:

```
integrate → (clearGrid → binParticles → solveCollisions → commit) × 2
```

#### `integrate`: dove va ogni sfera ([`simulation.ts:112`](../src/simulation.ts#L112))

Un thread per particella. Nell'ordine:

1. **Avanzamento locale della transizione.** `uMorph` è l'avanzamento globale (0 = AKQA, 1 = WPP). Ogni sfera lo ritarda di `targetB.w`, e da qui nasce l'onda che attraversa la parola da sinistra a destra:
   `local = smoothstep(clamp((morph − delay·0.45) / 0.55))`
2. **`burst = 4·local·(1−local)`**: vale 0 ai due estremi e 1 a metà. Controlla quanto la sfera si allontana dalla parola.
3. **La destinazione** della sfera è la somma di quattro componenti:
   - `home = mix(targetA, targetB, local)`: la posizione sulla parola;
   - `idle`: un rumore 3D (`mx_noise_vec3`) che cambia nel tempo, forte in z e debole in x/y. Così la parola resta "viva" ma leggibile;
   - `scatter × burst`: la dispersione a metà transizione;
   - `turbulence × burst`: un rumore che rende il volo meno rettilineo.
4. **Molla.** L'accelerazione è `(destinazione − posizione) × SPRING`. Durante il volo la molla si allenta (`mix(SPRING, SPRING·0.2, burst)`): le sfere si allontanano di più e poi rientrano con un piccolo rimbalzo.
5. **Mouse.** Se la sfera è entro `POINTER_RADIUS` dal punto del mouse, riceve una spinta verso l'esterno e **all'indietro** in z. È questo che produce l'effetto "ammaccatura" in profondità, invece di una semplice spinta laterale. Lo stesso calcolo si ripete per i 16 punti della **scia** (`uTrail`, [`simulation.ts:144`](../src/simulation.ts#L144)): sono posizioni recenti del puntatore, con raggio più piccolo e una forza che si spegne in pochi decimi di secondo.
6. **Ingresso al caricamento.** All'avvio le sfere partono poco disperse e più indietro in profondità (`INTRO_SPREAD`, `INTRO_DEPTH`). Alla destinazione si aggiunge uno scostamento che si riduce seguendo una curva *ease-out* (`uIntro`, circa 2,6 s), con un leggero sfasamento per sfera. La molla insegue quindi un bersaglio che si muove lentamente, invece di scattare verso la parola. In parallelo `uFade` porta il colore dal nero al bianco.
7. **Integrazione.** La velocità si aggiorna con l'accelerazione, viene smorzata (`exp(−DAMPING·dt)`) e limitata a `MAX_SPEED`. Poi `pos += vel·dt`.

L'intensità della spinta (`uPointerStrength`) si calcola sulla CPU e dipende dalla **velocità del puntatore** (vedi §5). Con il mouse fermo le sfere si deformano appena; con un movimento rapido vengono spinte con forza.

#### Collisioni: griglia + correzione ([`simulation.ts:157-216`](../src/simulation.ts#L157))

Confrontare ogni sfera con tutte le altre costerebbe 10.000² = 100 milioni di controlli. Lo spazio viene quindi diviso in celle grandi quanto il diametro massimo di una sfera: due sfere possono toccarsi solo se si trovano in celle adiacenti.

- **`clearGrid`**: azzera i contatori di tutte le celle.
- **`binParticles`**: ogni particella calcola la sua cella (`cellOf`) e ne ricava un indice nella tabella con un hash (`hashCell`, [`simulation.ts:105`](../src/simulation.ts#L105)). Con `atomicAdd` prenota uno dei 16 posti della cella e ci scrive il proprio indice. L'operazione **atomica** evita che due thread scrivano nello stesso posto contemporaneamente.
- **`solveCollisions`**: ogni particella scorre le 27 celle intorno a sé (3×3×3) e, per ogni vicina che la tocca, calcola quanto deve spostarsi per separarsi. Le sfere piccole si spostano più delle grandi, in proporzione al volume. Più celle lontane possono finire nello stesso slot della tabella hash, quindi si scartano le particelle che in realtà stanno in un'altra cella. La correzione viene scritta in `posNext` e una parte finisce anche nella velocità: l'urto ha conseguenze sul moto, non si limita a riposizionare. Nella stessa passata si conta anche il numero di vicini (`crowding`).
- **`commit`**: copia `posNext` in `pos`.

Perché serve `posNext`? Tutte le particelle leggono le posizioni delle vicine **nello stesso momento**. Se una scrivesse direttamente in `pos`, le altre leggerebbero valori a metà aggiornamento. Questo schema si chiama *Jacobi*. La coppia (griglia + correzione) viene ripetuta 2 volte per frame.

`namedLoop` ([`simulation.ts:58`](../src/simulation.ts#L58)) è un piccolo wrapper di `Loop`. Dà un nome diverso alle variabili dei due cicli annidati, perché i tipi di three non espongono l'opzione `name`.

### 4.3 Lo shader di disegno ([`simulation.ts:221-230`](../src/simulation.ts#L221))

Tutte le sfere si disegnano con **una sola chiamata**, tramite `InstancedMesh`: una sola geometria (`SphereGeometry` di raggio 1) ripetuta 10.000 volte. Il materiale è un normale `MeshStandardNodeMaterial` di three (PBR, reagisce alle luci della scena). Due sue proprietà vengono sostituite con nodi TSL:

```ts
const body = pos.toAttribute()                                   // pos[istanza] come attributo per istanza
material.positionNode = positionLocal.mul(body.w).add(body.xyz)   // vertice × raggio + centro
material.colorNode = vec3(mix(1, 0.42, packed).mul(mix(0.5, 1, depth)))
material.emissiveNode = vec3(0.7, 0.82, 1).mul(glow.toAttribute().mul(1.6))
```

- **`positionNode`**: per ogni vertice della sfera unitaria, lo scala del raggio (`w`) e lo sposta nel centro calcolato dalla simulazione. Il vertex shader legge **lo stesso buffer** scritto dal compute: niente copie, niente CPU.
- **`colorNode`**: il bianco viene scurito dove le sfere sono fitte (`crowding`) e dove sono più lontane in profondità. È un'occlusione ambientale approssimata ed economica, che aiuta a leggere i volumi.
- **`emissiveNode`**: fa brillare di bianco-azzurro le sfere attraversate dal puntatore. Il valore viene da un buffer `glow`, che `integrate` aggiorna così: sfera per sfera somma quanto è stata spinta da puntatore e scia (il "calore"). Se il calore è maggiore del bagliore attuale lo sostituisce, altrimenti il bagliore si spegne lentamente (`GLOW_DECAY`). Visto che la spinta dipende dalla velocità, un gesto rapido lascia una scia luminosa che si raffredda in circa mezzo secondo. Con il puntatore fermo il bagliore è praticamente nullo.

Illuminazione, riflessi e ombreggiatura sferica li gestisce il materiale standard di three.

### 4.4 La scia luminosa ([`src/fluid.ts`](../src/fluid.ts))

La scia visibile sul fondo nero non è fatta di particelle: è **fumo**, calcolato da una piccola simulazione di fluido 2D. Il metodo è quello classico degli *stable fluids*, lo stesso degli effetti "fluid cursor" che si vedono sul web, qui scritto interamente in TSL.

**La griglia.** Un rettangolo di 24 × 13,5 unità, parallelo alla parola e poco davanti (`PLANE_Z`), è diviso in 240 × 135 celle. Ogni cella ha diversi buffer:
- `velocity` (`vec2`): come si muove l'aria in quella cella;
- `dye` (`float`): quanta "luce/fumo" c'è;
- `pressure`, `divergence` e `curl`: valori di appoggio per il calcolo.

**Le passate a ogni frame** (un thread per cella):

1. **`splat`**: il puntatore immette fumo lungo il segmento che ha percorso nell'ultimo frame, con una sfumatura gaussiana (`SPLAT_RADIUS`), e **porta** la velocità dell'aria verso la propria. Non la *somma*: sommandola, a ogni passaggio l'energia si accumulerebbe, il fluido accelererebbe senza limite e il fumo finirebbe schiacciato contro i bordi in colonne verticali. La quantità è moltiplicata per l'energia del puntatore (§5): con il mouse fermo non entra nulla, con un gesto rapido entra molto fumo.
2. **`computeCurl` + `vorticity`**: misurano quanto ruota l'aria in ogni cella e rafforzano i vortici (*vorticity confinement*, `VORTICITY`). Senza questo passaggio il fumo si spalmerebbe in modo piatto; è qui che nasce l'aspetto di aria o liquido.
3. **`computeDivergence` + `jacobi` × 24 + `subtractGradient`**: rendono il flusso **incomprimibile**. L'aria non si accumula e non si svuota: si sposta e gira intorno. Le 24 iterazioni di Jacobi alternano due buffer di pressione, come le collisioni delle sfere.
   Un dettaglio che conta: la divergenza usa differenze all'indietro e il gradiente differenze in avanti. Combinate danno esattamente il Laplaciano a 5 punti che Jacobi inverte. Con differenze centrali in entrambi i passaggi resterebbe un'oscillazione "a scacchiera" cella per cella, che la correzione non vede e che col tempo diventa rumore a righe.
4. **`advect`**: ogni cella va a vedere dove si trovava il suo contenuto un istante prima (all'indietro lungo la velocità) e lo copia, con interpolazione bilineare. È così che il fumo viene trasportato dal flusso. Qui si applica anche la dissipazione (`DYE_DISSIPATION`, `VELOCITY_DISSIPATION`), che fa svanire la scia in un paio di secondi.
5. **`commit`**: copia il risultato nei buffer principali. Limita la velocità a `MAX_SPEED` (circa 2 celle per frame, oltre cui il trasporto perde nitidezza) e ferma l'aria sulle celle di bordo.

**Il disegno.** È un semplice piano con `MeshBasicNodeMaterial` in blending **additivo**, così il fumo si somma alla luce della scena senza coprirla:
- `colorNode` legge `dye` dal buffer con interpolazione bilineare, usando le `uv()` del piano;
- la densità viene convertita in luminosità con `1 − exp(−2·densità)`: poco fumo resta tenue, molto fumo satura senza bruciare;
- il colore passa da un azzurro chiaro per il fumo rarefatto al bianco per il fumo denso;
- i bordi del piano sfumano a zero, per non vedere il rettangolo.

Tutto avviene sulla GPU: la CPU passa solo il segmento del puntatore, la sua velocità e l'energia.

---

## 5. Cosa fa la CPU a ogni frame

Il callback `useFrame` in [`Particles.tsx:121`](../src/Particles.tsx#L121) fa poche operazioni, e nessuna riguarda le singole particelle:

1. **Scroll → morph.** Legge `scrollY` e lo converte in un valore tra 0 e 1. `morph` insegue questo valore con una **molla smorzata** ([`Particles.tsx:134`](../src/Particles.tsx#L134)). Se si inverte lo scroll a metà, cambia soltanto il valore da raggiungere: `morph` rallenta e torna indietro senza scatti e senza timeline da riavviare.
2. **Mouse.** Proietta la posizione del mouse sul piano z=0 della parola con un `Raycaster` ([`Particles.tsx:159`](../src/Particles.tsx#L159)). Il gruppo si inclina di poco seguendo il puntatore, per dare parallasse.
   Dallo spostamento del punto rispetto al frame precedente ricava una velocità, che viene convertita in un'**energia** tra 0 e 1. L'energia sale in fretta quando il mouse accelera e scende lentamente quando si ferma (è l'"inerzia"). La forza inviata allo shader è `POINTER_FORCE × (POINTER_REST + (1 − POINTER_REST) × energia)`: da ferma è solo il 2% di quella massima, quindi la deformazione è quasi impercettibile.
   Ogni volta che il puntatore si sposta di almeno `TRAIL_SPACING`, la posizione viene salvata in un buffer circolare di 16 uniform `vec4` (`xyz` = punto, `w` = forza). La forza iniziale è il 40% di quella attuale e a ogni frame si riduce di `exp(−dt / TRAIL_LIFETIME)`. Con il puntatore fermo non si salva nessun punto, quindi non si forma scia.
3. **Uniform.** Aggiorna `uMorph`, `uDt`, `uTime`, `uPointer` e `uPointerStrength`.
4. **GPU.** Chiama `sim.step(gl)`, che mette in coda le passate di calcolo.
5. **Scia luminosa.** Chiama `fluid.step(...)` con il segmento percorso dal puntatore nell'ultimo frame, la sua velocità smussata e un'intensità pari a `energia^1.5`. L'esponente fa sì che i movimenti lenti lascino pochissimo fumo e quelli rapidi molto. Dopo, R3F disegna.

I listener del mouse scrivono in un `useRef`, non nello stato React: in questo modo muovere il mouse non provoca re-render.

---

## 6. Parametri da regolare

| Cosa | Dove | Effetto |
| --- | --- | --- |
| Numero di sfere | `COUNT`, [`Particles.tsx:16`](../src/Particles.tsx#L16) | più sfere = sfere più piccole (volume occupato costante) |
| Densità del riempimento | `PACKING`, [`sampleWord.ts:6`](../src/sampleWord.ts#L6) | sfere più grandi e fitte, o più piccole e rade |
| Spessore delle lettere | `STROKE`, [`glyphs.ts:7`](../src/glyphs.ts#L7) | tratti più spessi o più sottili |
| Raggio e forza dell'hover | `POINTER_RADIUS` ([`simulation.ts:42`](../src/simulation.ts#L42)), `POINTER_FORCE` ([`Particles.tsx:23`](../src/Particles.tsx#L23)) | area e intensità massima della repulsione |
| Hover e velocità | `POINTER_REST`, `POINTER_FULL_SPEED` ([`Particles.tsx:24`](../src/Particles.tsx#L24)), rilascio `2.5` ([`Particles.tsx:177`](../src/Particles.tsx#L177)) | forza a puntatore fermo, velocità (unità/s) che dà la forza piena, durata dell'inerzia |
| Scia del puntatore | `TRAIL_GAIN`, `TRAIL_SPACING`, `TRAIL_LIFETIME` ([`Particles.tsx:26`](../src/Particles.tsx#L26)), `TRAIL_RADIUS` ([`simulation.ts:44`](../src/simulation.ts#L44)) | intensità, densità dei punti, durata e larghezza della scia |
| Scia luminosa (fumo) | `SPLAT_RADIUS`, `SPLAT_FORCE`, `SPLAT_DYE`, `VORTICITY`, `DYE_DISSIPATION` ([`fluid.ts:35`](../src/fluid.ts#L35)) | larghezza dello sbuffo, spinta, quantità di fumo, quanto vortica, quanto dura |
| Bagliore delle sfere | `GLOW_SCALE` ([`Particles.tsx:29`](../src/Particles.tsx#L29)), `GLOW_DECAY` ([`simulation.ts:43`](../src/simulation.ts#L43)) | intensità e durata del bagliore sulle sfere attraversate |
| Rigidità e smorzamento | `SPRING`, `DAMPING`, [`simulation.ts:36`](../src/simulation.ts#L36) | quanto le sfere restano ferme e quanto rimbalzano |
| Ampiezza dell'esplosione | `mag`, [`sampleWord.ts:180`](../src/sampleWord.ts#L180) | distanza raggiunta a metà transizione |
| Onda sinistra → destra | `MORPH_DELAY`, [`simulation.ts:39`](../src/simulation.ts#L39) | 0 = tutte insieme, valori alti = onda più marcata |
| Ingresso al caricamento | `INTRO_DURATION`, `FADE_DURATION` ([`Particles.tsx:21`](../src/Particles.tsx#L21)), `INTRO_SPREAD`, `INTRO_DEPTH` ([`simulation.ts:40`](../src/simulation.ts#L40)) | durata della composizione e della dissolvenza, distanza e profondità di partenza |
| Risposta allo scroll | `MORPH_STIFFNESS`, [`Particles.tsx:20`](../src/Particles.tsx#L20) | transizione più reattiva o più morbida |
| Qualità delle collisioni | `COLLISION_ITERATIONS`, `RELAXATION`, [`simulation.ts:46`](../src/simulation.ts#L46) | meno compenetrazione in cambio di più lavoro GPU |

Se si aumenta molto `COUNT`, conviene controllare che `SLOTS_PER_CELL` (16) basti ancora: se in una cella ci sono più particelle, le collisioni in eccesso vengono ignorate per quel frame.
