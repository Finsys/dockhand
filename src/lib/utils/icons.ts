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

export { iconMap };
