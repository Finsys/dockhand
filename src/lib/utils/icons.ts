import {
	Server, Globe, Cloud, Database, HardDrive, Cpu, Network, Box, Container, Monitor,
	Laptop, Smartphone, Tablet, Tv, Router, Wifi, Cable, Radio, Satellite, Building,
	Building2, Factory, Warehouse, House, Castle, Landmark, Store, School, Hospital,
	Terminal, Code, Binary, Braces, FileCode, GitBranch, GitCommitHorizontal, GitPullRequest,
	Settings, Cog, Wrench, Hammer, Package, Archive, FolderOpen,
	Shield, ShieldCheck, Lock, Key, Eye, EyeOff, TriangleAlert,
	Zap, Flame, Snowflake, Sun, Moon, Star, Sparkles, Heart, Crown, Gem,
	Anchor, Ship, Plane, Rocket, Car, Bike, TrainFront, Bus, Truck,
	Activity, BarChart3, ChartLine, ChartPie, TrendingUp, Gauge, Timer,
	Mail, MessageSquare, Phone, Video, Camera, Music, Headphones, Volume2,
	MapPin, Map, Compass, Navigation, Flag, Bookmark, Target
} from 'lucide-svelte';
import type { ComponentType } from 'svelte';

// Icon mapping for rendering
const iconMap: Record<string, ComponentType> = {
	'server': Server, 'globe': Globe, 'cloud': Cloud, 'database': Database, 'hard-drive': HardDrive,
	'cpu': Cpu, 'network': Network, 'box': Box, 'container': Container, 'monitor': Monitor,
	'laptop': Laptop, 'smartphone': Smartphone, 'tablet': Tablet, 'tv': Tv, 'router': Router,
	'wifi': Wifi, 'cable': Cable, 'radio': Radio, 'satellite': Satellite, 'building': Building,
	'building-2': Building2, 'factory': Factory, 'warehouse': Warehouse, 'home': House, 'castle': Castle,
	'landmark': Landmark, 'store': Store, 'school': School, 'hospital': Hospital,
	'terminal': Terminal, 'code': Code, 'binary': Binary, 'braces': Braces, 'file-code': FileCode,
	'git-branch': GitBranch, 'git-commit': GitCommitHorizontal, 'git-pull-request': GitPullRequest,
	'settings': Settings, 'cog': Cog, 'wrench': Wrench, 'hammer': Hammer,
	'package': Package, 'archive': Archive, 'folder-open': FolderOpen,
	'shield': Shield, 'shield-check': ShieldCheck, 'lock': Lock, 'key': Key,
	'eye': Eye, 'eye-off': EyeOff, 'alert-triangle': TriangleAlert,
	'zap': Zap, 'flame': Flame, 'snowflake': Snowflake, 'sun': Sun, 'moon': Moon,
	'star': Star, 'sparkles': Sparkles, 'heart': Heart, 'crown': Crown, 'gem': Gem,
	'anchor': Anchor, 'ship': Ship, 'plane': Plane, 'rocket': Rocket, 'car': Car,
	'bike': Bike, 'train': TrainFront, 'bus': Bus, 'truck': Truck,
	'activity': Activity, 'bar-chart': BarChart3, 'line-chart': ChartLine, 'pie-chart': ChartPie,
	'trending-up': TrendingUp, 'gauge': Gauge, 'timer': Timer,
	'mail': Mail, 'message-square': MessageSquare, 'phone': Phone, 'video': Video,
	'camera': Camera, 'music': Music, 'headphones': Headphones, 'volume-2': Volume2,
	'map-pin': MapPin, 'map': Map, 'compass': Compass, 'navigation': Navigation,
	'flag': Flag, 'bookmark': Bookmark, 'target': Target
};

export function getIconComponent(iconName: string): ComponentType {
	return iconMap[iconName] || Globe;
}

export function isCustomIcon(icon: string | null | undefined): boolean {
	return !!icon && icon.startsWith('custom:');
}

export function isSelfhstIcon(icon: string | null | undefined): boolean {
	return !!icon && icon.startsWith('selfhst:');
}

/** The selfh.st reference from a 'selfhst:<ref>' value, or null. */
export function selfhstRef(icon: string | null | undefined): string | null {
	return isSelfhstIcon(icon) ? icon!.slice('selfhst:'.length) : null;
}

/**
 * Whether an image is Dockhand's own image, so its container shows the app mark.
 * Matches the `dockhand` repo under the `fnsys`/`finsys` org from any registry,
 * ignoring the tag/digest (e.g. `fnsys/dockhand:v1.0.47`,
 * `docker.io/finsys/dockhand`, `registry.bor6.pl/dockhand@sha256:...`).
 */
export function isDockhandImage(image: string | null | undefined): boolean {
	if (!image) return false;
	const path = image.split('@')[0].split('/'); // drop digest, split path
	// The tag lives only in the LAST segment (after the last '/'); a registry
	// host may carry a ':port' earlier, so strip the tag from the last segment only.
	const name = path[path.length - 1].split(':')[0];
	if (name !== 'dockhand') return false;
	const org = path.length >= 2 ? path[path.length - 2] : '';
	// The official org, or a private-registry host (`registry.example/dockhand`).
	// A bare or unqualified `<org>/dockhand` is NOT matched - too broad.
	return org === 'fnsys' || org === 'finsys' || org.includes('.') || org.includes(':');
}

export { iconMap };

// --- Stack icon set (SEPARATE from env; app/service-oriented) --------------------
// A curated, app-focused set so a stack picker feels different from the env one.
// Every name is verified to exist in lucide-svelte 0.562.0.
import {
	DatabaseZap, FileStack, MonitorPlay, TvMinimalPlay, Music4, Disc3, Gamepad2, Joystick,
	Dices, Puzzle, Ghost, Trophy, Swords, ChartColumn, Thermometer,
	SignalHigh, Waypoints, Cctv, Rss, Webhook, Plug, Antenna, Radar, Bug, FlaskConical,
	Blocks, Component, Workflow, Boxes, Bot, BrainCircuit, Lightbulb, MessagesSquare,
	Send, Bell, Users, User, AtSign, Hash, FileText, NotebookPen, BookOpen, Library,
	Newspaper, ListTodo, Kanban, Calendar, Clock, KeyRound, Fingerprint, ScanLine, ShieldAlert,
	Files, CloudDownload, HardDriveDownload, Download, Upload, Save, CreditCard, Wallet, Receipt,
	Image as ImageIcon, Images, Film, Clapperboard, Mic, Podcast, FolderGit2, DollarSign,
	ShoppingCart, Feather, Palette,
	// --- extra app-oriented set (verified in lucide 0.562.0) ---
	Airplay, AlarmClock, Album, Aperture, AppWindow, Atom, Award, Backpack, Banknote, Battery,
	Beaker, Bean, Bird, Bitcoin, Bluetooth, Bomb, Bone, BookMarked, Briefcase, Brush, Cake,
	Calculator, CalendarClock, CandlestickChart, Cast, Cat, ChefHat, Cherry, Cigarette, Clipboard,
	Cloudy, Clover, Coffee, Coins, Combine, Contact, Cookie, Croissant, Diamond, Dna, Dog, DoorOpen,
	Drum, Dumbbell, Earth, Egg, Factory as FactoryIcon, FerrisWheel, FileArchive, Flower, Focus,
	Folder, Forklift, Frame, Fuel, Gift, GitFork, Grape, Grid3x3, HardHat, Hexagon, History,
	Hourglass, IceCream, Inbox, Infinity, Keyboard, Lamp, Landmark as LandmarkIcon, Laptop as LaptopIcon,
	Leaf, Link, Magnet, Mailbox, Medal, Megaphone, Microscope, Milk, Monitor as MonitorIcon, Mountain,
	Mouse, Orbit, Paperclip, Parentheses, PartyPopper, Pencil, PiggyBank, Pin, Pizza,
	Popcorn, Power, Printer, Recycle, Ruler, Satellite as SatelliteIcon, Scale, School as SchoolIcon,
	Scissors, ScreenShare, Settings as SettingsIcon, Shovel, Shrub, Siren, Skull, Smartphone as SmartphoneIcon,
	Speaker, Sprout, Sword, Syringe, Table, Tablet as TabletIcon, Tag, Telescope, Tent, Thermometer as ThermometerIcon2,
	ThumbsUp, Ticket, ToyBrick, Trash, TreePine, Truck as TruckIcon, Tv as TvIcon, Umbrella, University,
	Usb, Verified, Wand, Watch, Waves, Wind, Wine
} from 'lucide-svelte';

const stackIconMap: Record<string, ComponentType> = {
	// data / db / storage
	'database': Database, 'database-zap': DatabaseZap, 'server': Server, 'hard-drive': HardDrive,
	'boxes': Boxes, 'container': Container, 'box': Box, 'layers': FileStack, 'archive': Archive,
	'files': Files, 'folder-open': FolderOpen, 'package': Package, 'save': Save,
	'cloud-download': CloudDownload, 'hard-drive-download': HardDriveDownload, 'download': Download, 'upload': Upload,
	// media
	'film': Film, 'clapperboard': Clapperboard, 'monitor-play': MonitorPlay, 'tv-play': TvMinimalPlay,
	'music': Music4, 'disc': Disc3, 'headphones': Headphones, 'mic': Mic, 'podcast': Podcast,
	'image': ImageIcon, 'images': Images, 'camera': Camera, 'video': Video, 'radio': Radio,
	// gaming
	'gamepad': Gamepad2, 'joystick': Joystick, 'dices': Dices, 'puzzle': Puzzle, 'ghost': Ghost,
	'trophy': Trophy, 'swords': Swords,
	// monitoring / metrics
	'activity': Activity, 'bar-chart': ChartColumn, 'line-chart': ChartLine, 'pie-chart': ChartPie,
	'gauge': Gauge, 'trending-up': TrendingUp, 'cpu': Cpu, 'thermometer': Thermometer,
	'signal': SignalHigh, 'waypoints': Waypoints,
	// network / proxy
	'network': Network, 'globe': Globe, 'router': Router, 'wifi': Wifi, 'cable': Cable,
	'cctv': Cctv, 'rss': Rss, 'webhook': Webhook, 'plug': Plug, 'antenna': Antenna, 'radar': Radar,
	// dev / code
	'code': Code, 'terminal': Terminal, 'git-branch': GitBranch, 'folder-git': FolderGit2,
	'braces': Braces, 'binary': Binary, 'bug': Bug, 'flask': FlaskConical, 'blocks': Blocks,
	'component': Component, 'workflow': Workflow,
	// automation / home
	'bot': Bot, 'brain': BrainCircuit, 'home': House, 'lightbulb': Lightbulb, 'zap': Zap,
	'cog': Cog, 'wrench': Wrench,
	// comms / social
	'mail': Mail, 'message-square': MessageSquare, 'messages': MessagesSquare, 'send': Send,
	'bell': Bell, 'users': Users, 'user': User, 'phone': Phone, 'at-sign': AtSign, 'hash': Hash,
	// productivity / docs
	'file-text': FileText, 'notebook': NotebookPen, 'book-open': BookOpen, 'library': Library,
	'newspaper': Newspaper, 'list-todo': ListTodo, 'kanban': Kanban, 'calendar': Calendar,
	'clock': Clock, 'bookmark': Bookmark,
	// security
	'shield': Shield, 'shield-check': ShieldCheck, 'shield-alert': ShieldAlert, 'lock': Lock,
	'key': Key, 'key-round': KeyRound, 'fingerprint': Fingerprint, 'scan': ScanLine,
	// finance / commerce
	'dollar': DollarSign, 'shopping-cart': ShoppingCart, 'credit-card': CreditCard,
	'wallet': Wallet, 'receipt': Receipt, 'store': Store,
	// identity / misc
	'rocket': Rocket, 'flame': Flame, 'star': Star, 'sparkles': Sparkles, 'heart': Heart,
	'anchor': Anchor, 'ship': Ship, 'cloud': Cloud, 'feather': Feather, 'palette': Palette,
	'gem': Gem, 'crown': Crown, 'target': Target, 'flag': Flag, 'compass': Compass,
	// extra set
	'airplay': Airplay, 'alarm-clock': AlarmClock, 'album': Album, 'aperture': Aperture,
	'app-window': AppWindow, 'atom': Atom, 'award': Award, 'backpack': Backpack, 'banknote': Banknote,
	'battery': Battery, 'beaker': Beaker, 'bean': Bean, 'bird': Bird, 'bitcoin': Bitcoin,
	'bluetooth': Bluetooth, 'bomb': Bomb, 'bone': Bone, 'book-marked': BookMarked, 'briefcase': Briefcase,
	'brush': Brush, 'cake': Cake, 'calculator': Calculator, 'calendar-clock': CalendarClock,
	'candlestick': CandlestickChart, 'cast': Cast, 'cat': Cat, 'chef-hat': ChefHat, 'cherry': Cherry,
	'cigarette': Cigarette, 'clipboard': Clipboard, 'cloudy': Cloudy, 'clover': Clover, 'coffee': Coffee,
	'coins': Coins, 'combine': Combine, 'contact': Contact, 'cookie': Cookie, 'croissant': Croissant,
	'diamond': Diamond, 'dna': Dna, 'dog': Dog, 'door-open': DoorOpen, 'drum': Drum, 'dumbbell': Dumbbell,
	'earth': Earth, 'egg': Egg, 'factory': FactoryIcon, 'ferris-wheel': FerrisWheel, 'file-archive': FileArchive,
	'flower': Flower, 'focus': Focus, 'folder': Folder, 'forklift': Forklift, 'frame': Frame, 'fuel': Fuel,
	'gift': Gift, 'git-fork': GitFork, 'grape': Grape, 'grid': Grid3x3, 'hard-hat': HardHat, 'hexagon': Hexagon,
	'history': History, 'hourglass': Hourglass, 'ice-cream': IceCream, 'inbox': Inbox, 'infinity': Infinity,
	'keyboard': Keyboard, 'lamp': Lamp, 'landmark': LandmarkIcon, 'laptop': LaptopIcon, 'leaf': Leaf,
	'link': Link, 'magnet': Magnet, 'mailbox': Mailbox, 'medal': Medal, 'megaphone': Megaphone,
	'microscope': Microscope, 'milk': Milk, 'monitor': MonitorIcon, 'mountain': Mountain, 'mouse': Mouse,
	'orbit': Orbit, 'paperclip': Paperclip, 'parentheses': Parentheses,
	'party-popper': PartyPopper, 'pencil': Pencil, 'piggy-bank': PiggyBank, 'pin': Pin, 'pizza': Pizza,
	'popcorn': Popcorn, 'power': Power, 'printer': Printer, 'recycle': Recycle, 'ruler': Ruler,
	'satellite': SatelliteIcon, 'scale': Scale, 'school': SchoolIcon, 'scissors': Scissors, 'screen-share': ScreenShare,
	'settings': SettingsIcon, 'shovel': Shovel, 'shrub': Shrub, 'siren': Siren, 'skull': Skull,
	'smartphone': SmartphoneIcon, 'speaker': Speaker, 'sprout': Sprout, 'sword': Sword, 'syringe': Syringe,
	'table': Table, 'tablet': TabletIcon, 'tag': Tag, 'telescope': Telescope, 'tent': Tent,
	'thermometer2': ThermometerIcon2, 'thumbs-up': ThumbsUp, 'ticket': Ticket, 'toy-brick': ToyBrick,
	'trash': Trash, 'tree': TreePine, 'truck': TruckIcon, 'tv': TvIcon, 'umbrella': Umbrella,
	'university': University, 'usb': Usb, 'verified': Verified, 'wand': Wand, 'watch': Watch,
	'waves': Waves, 'wind': Wind, 'wine': Wine
};

/** Component for a stack lucide-name icon, defaulting to Boxes (a stack-y default). */
export function getStackIconComponent(iconName: string): ComponentType {
	return stackIconMap[iconName] || Boxes;
}

export { stackIconMap };
