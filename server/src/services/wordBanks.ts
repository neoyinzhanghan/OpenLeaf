/**
 * Word banks for generated share credentials.
 *
 *  - CREATURES: real animals plus mythical / folkloric beings. Used for
 *    guest usernames (`<creature>-<digits>`).
 *  - CELESTIAL: stars, moons, nebulae, galaxies. Used for the themed
 *    invitation path. Deliberately a different domain from CREATURES so a
 *    link never hints at the username; any accidental overlap is removed
 *    at module load.
 *
 * All entries are lower-case, ASCII, single tokens.
 */

const ANIMALS = `
aardvark aardwolf addax adder agouti akita albatross alligator alpaca anaconda anchovy angelfish anhinga anole ant anteater antelope
aoudad apapane aphid arapaima archerfish argali armadillo asp auk avocet axolotl aye
babirusa baboon badger bandicoot barb barbet barnacle barracuda basilisk bass bat beagle bear beaver bee beetle beluga bettong bilby
binturong bird bison bittern blackbird blackbuck bleak blenny bluebird bluegill boa boar bobcat bobolink bongo bonito bonobo booby
bowerbird bowhead boxfish brant bream brolga budgie buffalo bulbul bullfrog bullhead bumblebee bunting burbot bushbaby bustard butterfly buzzard
caiman camel canary capuchin capybara caracal caracara cardinal caribou carp cassowary cat caterpillar catfish cavy chameleon chamois char
cheetah chickadee chicken chimpanzee chinchilla chinook chipmunk chital chough chub cicada cichlid civet clam clownfish coati cobra cockatoo
cockle cod coelacanth colugo condor coot copepod coral cormorant corncrake cougar cowbird coyote coypu crab crane crayfish cricket crocodile
crossbill crow cuckoo curlew cuscus cuttlefish
dab dace damselfly darter dassie deer degu dhole dikdik dingo dipper discus dodo dog dolphin donkey dormouse dotterel dove dragonet dragonfly
drongo duck dugong duiker dunlin dunnock
eagle earwig echidna eel eft egret eider eland elephant elk emu ermine
falcon fennec ferret finch firefly fisher flamingo flounder fly flycatcher fossa fox frigatebird frog fulmar
gadwall galah gannet gar garfish gaur gazelle gecko gelada gemsbok gerbil gerenuk gharial gibbon gila giraffe glider gnat gnu goat godwit
goldcrest goldfinch goldfish goose gopher goral gorilla goshawk gosling grackle grasshopper grayling grebe greenfinch greenshank greyhound grison
grosbeak grouper grouse grunion guanaco gudgeon guillemot guinea gull gundi guppy gurnard gyrfalcon
haddock hagfish hake halibut hamster hare harrier hartebeest hawfinch hawk hedgehog hellbender heron herring hoatzin hobby hogfish honeybee
honeyeater hoopoe hornbill hornet horse hoverfly hummingbird husky hutia hyena hyrax
ibex ibis iguana impala inchworm indri isopod
jacamar jacana jackal jackdaw jaeger jaguar jaguarundi javelina jay jellyfish jerboa junco
kagu kakapo kangaroo katydid kea kestrel killdeer killifish kingbird kingfisher kinglet kinkajou kite kittiwake kiwi klipspringer knot koala
kob kodiak koel kokanee komodo kookaburra kouprey krill kudu
labrador ladybird ladybug lamprey langur lapwing lark leech lemming lemur leopard limpet limpkin ling linnet lion lionfish lizard llama loach
lobster locust longspur loon loris lory louse lovebird lumpsucker lungfish lynx lyrebird
macaque macaw mackerel magpie mallard mamba manatee mandrill mangabey manta mantis mara margay markhor marlin marmoset marmot marten martin
mastiff mayfly meadowlark meerkat megamouth merganser merlin millipede mink minnow mite mockingbird mole mollusk mongoose monitor monkey moorhen
moose moray morwong mosquito moth motmot mouflon mouse mudpuppy mudskipper mule mullet muntjac murre murrelet muskox muskrat mussel myna
narwhal nautilus needlefish nene newt nightingale nightjar nilgai noddy numbat nutcracker nuthatch nyala
oarfish ocelot octopus okapi olingo olm onager opah opossum orangutan orca oriole oropendola oryx osprey ostrich otter ouzel ovenbird owl ox
oxpecker oyster oystercatcher
paca pacu paddlefish pademelon pangolin panther parakeet parrot parrotfish partridge peacock peafowl pelican penguin perch peregrine petrel
phalarope pheasant pichi pig pigeon pika pike pilchard pintail pipefish pipistrelle pipit piranha pitta planarian platypus plover pochard
polecat pollock pony porcupine porpoise possum potoo potoroo prairiedog prawn pronghorn ptarmigan puffin puku puma python
quagga quail quelea quetzal quokka quoll
rabbit raccoon rail rat rattlesnake raven ray razorbill redpoll redshank redstart reedbuck reindeer remora rhea rhebok rhinoceros roadrunner
robin rockfish roller rook rooster rorqual rosefinch rosella ruff
sable saiga sailfish saki salamander salmon saluki sambar sanderling sandgrouse sandpiper sapsucker sardine sawfish scallop scaup scorpion
seahorse seal serow serval shag shark shearwater sheep shelduck shoebill shoveler shrew shrike shrimp sifaka siskin sitatunga skate skimmer
skink skipjack skua skunk skylark sloth slug smelt snail snake snapper snipe snook sole solenodon sora sparrow sparrowhawk spider spoonbill
springbok springhare squid squirrel starling steenbok stilt stingray stoat stonechat stork sturgeon sunbird sunfish surgeonfish swallow swan
swift swordfish
tahr takahe takin tamandua tamarin tanager tang tapaculo tapir tarantula tarpon tarsier tayra teal tench tenrec termite tern terrapin thrasher
thrush tiger tilapia tinamou tit titmouse toad tomtit topi tortoise toucan towhee tragopan treecreeper trogon trout tuatara tuna turaco
turbot turkey turnstone turtle tusker
uakari umbrellabird urchin urial
vaquita veery vervet vicuna viper vireo vole vulture
wagtail wallaby wallaroo walrus wapiti warbler warthog wasp waterbuck waxwing weasel weevil weka whale wheatear whimbrel whinchat whippet
whydah wigeon wildebeest wisent wolf wolverine wombat woodchuck woodcock woodlark woodpecker wrasse wren wryneck
xantus xerus
yak yellowhammer yellowlegs yellowtail
zander zebra zebu zorilla
`;

const MYTHICAL = `
abaia abarimon acheri adlet afanc ahool ahuizotl aitvaras akaname akhlut alicanto alkonost alp amarok ammit amphisbaena anansi anzu aqrabuamelu
argus aspidochelone aswang azeban
bakeneko baku balaur banshee barghest barometz basan behemoth bennu bergrisi bhuta bigfoot bishopfish blemmyae boggart bogle bonnacon
brownie bucca bugbear bunyip buraq
cabeiri cacus caladrius calygreyhound camazotz capricorn catoblepas cecaelia centaur cerberus cetus changeling charybdis chimera chollima chupacabra
cikavac cockatrice colo cuegle curupira cyclops cynocephalus
dahu daitya dilong dipsa djinn dobhar doppelganger dragon drake draugr dryad dullahan dwarf dybbuk
echidna einherjar elf eloko emela empusa encantado enfield erinys erymanthian
fachan fafnir fairy faun fenghuang fenrir fext firebird fomorian fossegrim fuath furies
gancanagh gargoyle garuda gashadokuro geryon ghillie ghoul giant gigelorum glaistig glashtyn gnome goblin gogmagog golem gorgon gremlin
griffin grindylow grootslang gryphon gulon gumiho gwyllion gytrash
hamadryad harpy hellhound hippocampus hippogriff hircocervus hobgoblin hodag homunculus hraesvelgr huldra huma hydra
ichthyocentaur ifrit ijiraq imp incubus indrik ipotane itzpapalotl
jackalope jengu jinn jorogumo jormungandr jotunn
kappa karkadann kelpie kirin kitsune kludde knucker kobold kraken kumiho
ladon lamassu lamia lampad leprechaun leshy leucrota leviathan lich lindworm longma lycan
makara manananggal mandrake manticore marid melusine merlion mermaid merrow minotaur mishipeshu mokele monoceros mooncalf morgen mothman
mushussu myrmecoleon
naga nagual namazu nekomata nephilim nereid nightmare ningyo nisse nix nuckelavee nue nuppeppo nymph
oceanid ogre oni onocentaur onryo orthrus otoroshi ouroboros
pegasus peluda peryton phoenix piasa pixie pooka puca pyrausta python
qilin questingbeast
rakshasa raiju ratatoskr redcap revenant roc rusalka
salamander sasquatch satyr scylla selkie seraph serpopard shedu shishi simurgh siren skinwalker sleipnir snallygaster sphinx sprite squonk
strix stymphalian succubus surtr sylph
tanuki taniwha tarasque tatzelwurm tengu thunderbird tikbalang titan tokoloshe triton troll tsuchinoko typhon
undine unicorn urmahlullu
valkyrie vampire vanara vetala vodyanoy vouivre
wampus wendigo werewolf wight wraith wyrm wyvern
xiezhi xing
yale yeti yowie yuki
zaratan ziz zmey
`;

const STARS_AND_SKY = `
achernar acrux adhara albireo alcor alcyone aldebaran alderamin algenib algieba algol alhena alioth alkaid almach alnair alnilam alnitak
alphard alphecca alpheratz altair aludra ankaa antares arcturus arneb ascella asterope atlas atria avior
bellatrix betelgeuse
canopus capella caph castor celaeno chara cursa
deneb denebola diphda dschubba dubhe
electra elnath eltanin enif errai
fomalhaut furud
gacrux gienah gomeisa
hadar hamal
izar
kaus kochab kraz
maia markab meissa menkalinan menkar menkent merak merope mesarthim miaplacidus mimosa mintaka mira mirach mirfak mirzam mizar muphrid
naos nashira nekkar nihal nunki
okab
peacock phact phecda pherkad pleione polaris pollux porrima procyon propus
rasalgethi rasalhague rastaban regulus rigel rotanev ruchbah rukbat
sabik sadalbari sadalmelik sadalsuud sadr saiph sargas sarin scheat schedar segin seginus shaula sheliak sheratan sirius skat spica sualocin
suhail sulafat syrma
tabit talitha tania tarazed taygeta tegmine tejat thuban tiaki tureis
unukalhai
vega vindemiatrix
wasat wazn wezen
yildun
zaniah zaurak zavijava zosma zubenelgenubi
`;

const MOONS_AND_DEEP_SKY = `
adrastea aitne amalthea ananke aoede arche atlas autonoe bebhionn belinda bianca caliban callirrhoe callisto calypso carme carpo chaldene
charon cordelia cressida cupid cyllene daphnis deimos desdemona despina dia dione elara enceladus epimetheus erinome euanthe eukelade
euporie europa eurydome ferdinand francisco galatea ganymede halimede harpalyke hegemone helene helike hermippe herse himalia hyperion
iapetus io iocaste isonoe janus juliet kale kallichore kalyke kerberos kiviuq kore laomedeia larissa leda lysithea mab margaret
methone metis mimas miranda mneme naiad namaka narvi nereid nix oberon ophelia orthosie paaliaq pallene pandora pasiphae pasithee
perdita phobos phoebe polydeuces portia praxidike prometheus prospero proteus psamathe puck rhea rosalind sao setebos sinope skathi
sponde stephano styx sycorax taygete telesto tethys thalassa thebe thelxinoe themisto thyone titan titania trinculo umbriel weywot
xanthe ymir
andromeda antlia auriga bootes caelum carina cepheus circinus columba coma crater eridanus fornax hercules horologium indus lyra
mensa microscopium norma octans ophiuchus perseus pictor pyxis reticulum sagitta sculptor scutum sextans telescopium triangulum vela
helix trifid lagoon eagle omega rosette pelican crescent bubble tarantula veil cocoon flame horsehead pinwheel whirlpool sombrero cigar
sunflower cartwheel triangulum bode centaurus fornax messier caldwell abell
`;

function toBank(...blocks: string[]): string[] {
  const seen = new Set<string>();
  for (const block of blocks) {
    for (const raw of block.split(/\s+/)) {
      const w = raw.trim().toLowerCase();
      if (/^[a-z]{3,}$/.test(w)) seen.add(w);
    }
  }
  return Array.from(seen).sort();
}

export const CREATURES: readonly string[] = toBank(ANIMALS, MYTHICAL);

const creatureSet = new Set(CREATURES);
/** Celestial bank with anything that also names a creature removed (e.g. "eagle", "pegasus"). */
export const CELESTIAL: readonly string[] = toBank(STARS_AND_SKY, MOONS_AND_DEEP_SKY).filter((w) => !creatureSet.has(w));
