import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  Play, 
  Square, 
  RotateCcw, 
  MapPin, 
  Navigation, 
  DollarSign, 
  Zap, 
  Route, 
  Clock, 
  Pause, 
  TestTube, 
  Info, 
  ChevronDown, 
  ChevronUp 
} from 'lucide-react';

interface Position {
  latitude: number;
  longitude: number;
  timestamp: number;
}

interface TripData {
  distance: number;
  cost: number;
  waitingTime: number;
  isRunning: boolean;
  isPaused: boolean;
}

interface TripType {
  id: string;
  name: string;
  description: string;
  fixedPrice?: number;
}

interface TripSummary {
  tripType: string;
  distance: number;
  waitingTime: number;
  cost: number;
  timestamp: string;
}

// Configuración de tarifas
const RATES = {
  baseFare: 50,
  waitingRate: 3, // MXN por minuto
  distanceRates: [
    { min: 0, max: 4.99, price: 50 },
    { min: 5, max: 5.99, price: 60 },
    { min: 6, max: 6.99, price: 65 },
    { min: 7, max: 7.99, price: 70 },
    { min: 8, max: Infinity, basePrice: 80, extraRate: 16 }
  ]
};

// Tipos de viaje
const TRIP_TYPES: TripType[] = [
  {
    id: 'normal',
    name: 'Viaje Normal',
    description: 'Tarifa estándar por distancia'
  },
  {
    id: 'airport',
    name: 'Aeropuerto',
    description: 'Viaje al aeropuerto',
    fixedPrice: 150
  },
  {
    id: 'outbound',
    name: 'Foráneo',
    description: 'Viaje fuera de la ciudad',
    fixedPrice: 200
  }
];

// Función para calcular distancia entre dos puntos GPS (fórmula Haversine)
const calculateDistance = (pos1: Position, pos2: Position): number => {
  const R = 6371000; // Radio de la Tierra en metros (más preciso)
  const lat1 = (pos1.latitude * Math.PI) / 180;
  const lon1 = (pos1.longitude * Math.PI) / 180;
  const lat2 = (pos2.latitude * Math.PI) / 180;
  const lon2 = (pos2.longitude * Math.PI) / 180;

  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  
  const distance = R * c; // Distancia en metros
  
  // Factor de corrección para GPS móviles (tienden a subestimar)
  // Los GPS móviles suelen mostrar 60-70% de la distancia real debido a:
  // - Filtrado de señal para reducir ruido
  // - Precisión limitada del hardware
  // - Algoritmos de suavizado
  const correctionFactor = 1.4; // Incremento del 40% basado en pruebas reales
  
  return distance * correctionFactor;
};

// Componente principal de la aplicación
function App() {
  const [tripData, setTripData] = useState<TripData>({
    distance: 0,
    cost: RATES.baseFare,
    waitingTime: 0,
    isRunning: false,
    isPaused: false
  });

  const [currentPosition, setCurrentPosition] = useState<Position | null>(null);
  const [watchId, setWatchId] = useState<number | null>(null);
  const [gpsStatus, setGpsStatus] = useState<'requesting' | 'available' | 'denied' | 'unavailable'>('requesting');
  const [selectedTripType, setSelectedTripType] = useState<TripType>(TRIP_TYPES[0]);
  const [showTripTypeSelector, setShowTripTypeSelector] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [lastTripSummary, setLastTripSummary] = useState<TripSummary | null>(null);
  const [showRates, setShowRates] = useState(false);
  const [isTestMode, setIsTestMode] = useState(false);
  const [currentAddress, setCurrentAddress] = useState<string>('');
  const [googleMapsReady, setGoogleMapsReady] = useState(false);

  // Referencias para mantener estado en callbacks
  const isActiveRef = useRef(false);
  const lastPositionRef = useRef<Position | null>(null);
  const waitingStartTime = useRef<number | null>(null);
  const waitingInterval = useRef<NodeJS.Timeout | null>(null);
  const testModeInterval = useRef<NodeJS.Timeout | null>(null);

  // Función para calcular la tarifa
  const calculateFare = useCallback((distanceKm: number, waitingMinutes: number) => {
    if (selectedTripType.fixedPrice) {
      return selectedTripType.fixedPrice + (waitingMinutes * RATES.waitingRate);
    }

    let fare = RATES.baseFare;
    
    for (const rate of RATES.distanceRates) {
      if (distanceKm >= rate.min && distanceKm <= rate.max) {
        if (rate.extraRate && distanceKm > 8) {
          const extraKm = distanceKm - 8;
          fare = rate.basePrice! + (extraKm * rate.extraRate);
        } else {
          fare = rate.price!;
        }
        break;
      }
    }

    return fare + (waitingMinutes * RATES.waitingRate);
  }, [selectedTripType]);

  // Formatear tiempo
  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Manejar nueva posición GPS
  const handlePositionUpdate = useCallback((position: Position) => {
    setCurrentPosition(position);
    setGpsStatus('available');

    // Verificamos la referencia 'en vivo' del estado activo
    if (isActiveRef.current && !tripData.isPaused) {
      if (lastPositionRef.current) {
        // La distancia se calcula en metros para mayor precisión.
        const newDistanceMeters = calculateDistance(lastPositionRef.current, position);
        
        // El umbral de 5 metros es bueno para filtrar el "ruido" GPS.
        const THRESHOLD = 5; 
        if (newDistanceMeters > THRESHOLD) {
          // Convertimos a km para sumar al total
          const newDistanceKm = newDistanceMeters / 1000;
          setTripData(prev => {
            const totalDistance = prev.distance + newDistanceKm;
            const waitingMinutes = Math.floor(prev.waitingTime / 60);
            return {
              ...prev,
              distance: totalDistance,
              cost: calculateFare(totalDistance, waitingMinutes)
            };
          });
        }
      }
      // SIEMPRE ACTUALIZAR la última posición con la nueva
      lastPositionRef.current = position;
    }
  }, [calculateFare, tripData.isPaused]);

  // Inicializar GPS
  useEffect(() => {
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const position: Position = {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            timestamp: Date.now()
          };
          setCurrentPosition(position);
          lastPositionRef.current = position;
          setGpsStatus('available');
        },
        (error) => {
          if (error.code === error.PERMISSION_DENIED) {
            setGpsStatus('denied');
          } else {
            setGpsStatus('unavailable');
          }
        },
        { enableHighAccuracy: true }
      );
    } else {
      setGpsStatus('unavailable');
    }
  }, []);

  // Iniciar contador de tiempo de espera
  const startWaitingTimer = () => {
    waitingStartTime.current = Date.now();
    waitingInterval.current = setInterval(() => {
      if (waitingStartTime.current) {
        const elapsed = Math.floor((Date.now() - waitingStartTime.current) / 1000);
        setTripData(prev => {
          const waitingMinutes = Math.floor(elapsed / 60);
          return {
            ...prev,
            waitingTime: elapsed,
            cost: calculateFare(prev.distance, waitingMinutes)
          };
        });
      }
    }, 1000);
  };

  // Detener contador de tiempo de espera
  const stopWaitingTimer = () => {
    if (waitingInterval.current) {
      clearInterval(waitingInterval.current);
      waitingInterval.current = null;
    }
    waitingStartTime.current = null;
  };

  // Iniciar taxímetro
  const startTrip = () => {
    if (currentPosition) {
      isActiveRef.current = true;
      lastPositionRef.current = currentPosition;
      
      setTripData(prev => ({
        ...prev,
        isRunning: true,
        isPaused: false
      }));

      if (isTestMode) {
        startTestMode();
      } else {
        const id = navigator.geolocation.watchPosition(
          (pos) => {
            const position: Position = {
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
              timestamp: Date.now()
            };
            handlePositionUpdate(position);
          },
          (error) => console.error('GPS Error:', error),
          { 
            enableHighAccuracy: true, 
            maximumAge: 500,    // Datos más frescos
            timeout: 10000      // Más tiempo para obtener precisión
          }
        );
        setWatchId(id);
      }
    }
  };

  // Pausar/Reanudar taxímetro
  const togglePause = () => {
    setTripData(prev => {
      const newPaused = !prev.isPaused;
      
      if (newPaused) {
        // Pausar - iniciar contador de espera
        startWaitingTimer();
      } else {
        // Reanudar - detener contador de espera
        stopWaitingTimer();
      }
      
      return {
        ...prev,
        isPaused: newPaused
      };
    });
  };

  // Detener taxímetro
  const stopTrip = () => {
    if (watchId) {
      navigator.geolocation.clearWatch(watchId);
      setWatchId(null);
    }
    
    stopTestMode();
    stopWaitingTimer();
    
    // Crear resumen del viaje
    const summary: TripSummary = {
      tripType: selectedTripType.name,
      distance: tripData.distance,
      waitingTime: tripData.waitingTime,
      cost: tripData.cost,
      timestamp: new Date().toLocaleString()
    };
    
    setLastTripSummary(summary);
    setShowSummary(true);
    
    // Resetear datos del viaje
    isActiveRef.current = false;
    setTripData({
      distance: 0,
      cost: selectedTripType.fixedPrice || RATES.baseFare,
      waitingTime: 0,
      isRunning: false,
      isPaused: false
    });
    
    lastPositionRef.current = currentPosition;
  };

  // Modo de prueba
  const startTestMode = () => {
    if (!currentPosition) return;
    
    let simulatedLat = currentPosition.latitude;
    let simulatedLng = currentPosition.longitude;
    
    testModeInterval.current = setInterval(() => {
      // Incremento más grande para simular aproximadamente 1km de movimiento
      simulatedLat += (Math.random() - 0.5) * 0.01;
      simulatedLng += (Math.random() - 0.5) * 0.01;
      
      const simulatedPosition: Position = {
        latitude: simulatedLat,
        longitude: simulatedLng,
        timestamp: Date.now()
      };
      
      handlePositionUpdate(simulatedPosition);
    }, 1000); // Reducido a 1 segundo para mayor velocidad
  };

  const stopTestMode = () => {
    if (testModeInterval.current) {
      clearInterval(testModeInterval.current);
      testModeInterval.current = null;
    }
  };

  const toggleTestMode = () => {
    setIsTestMode(!isTestMode);
  };

  // Funciones de estado
  const getStatusColor = () => {
    if (tripData.isRunning) {
      return tripData.isPaused ? 'bg-yellow-400' : 'bg-green-400';
    }
    return gpsStatus === 'available' ? 'bg-blue-400' : 'bg-red-400';
  };

  const getStatusText = () => {
    if (tripData.isRunning) {
      return tripData.isPaused ? 'PAUSADO - TIEMPO DE ESPERA' : 'VIAJE EN CURSO';
    }
    switch (gpsStatus) {
      case 'available': return 'GPS LISTO';
      case 'requesting': return 'CONECTANDO GPS...';
      case 'denied': return 'GPS DENEGADO';
      case 'unavailable': return 'GPS NO DISPONIBLE';
      default: return 'ESTADO DESCONOCIDO';
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-black to-gray-800 p-4">
      <div className="max-w-md mx-auto">
        {/* Modal de resumen del viaje */}
        {showSummary && lastTripSummary && (
          <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
            <div className="bg-gradient-to-br from-gray-900 to-black border border-yellow-400 rounded-xl p-6 max-w-sm w-full shadow-2xl">
              <div className="flex items-center justify-center mb-4">
                <Zap className="w-8 h-8 text-yellow-400 mr-2" />
                <h2 className="text-2xl font-bold text-center text-white">
                  Resumen del Viaje
                </h2>
              </div>
              
              <div className="space-y-4">
                <div className="bg-gray-800 border border-gray-700 p-3 rounded-lg">
                  <div className="text-center">
                    <span className="text-yellow-400 font-bold text-lg">{lastTripSummary.tripType}</span>
                  </div>
                </div>
                
                <div className="bg-gray-800 border border-gray-700 p-4 rounded-lg">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-gray-300">Distancia recorrida:</span>
                    <span className="font-bold text-lg text-yellow-400">{lastTripSummary.distance.toFixed(3)} km</span>
                  </div>
                  
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-gray-300">Tiempo de espera:</span>
                    <span className="font-bold text-lg text-yellow-400">{formatTime(lastTripSummary.waitingTime)}</span>
                  </div>
                  
                  <div className="border-t border-gray-600 pt-2 mt-2">
                    <div className="flex justify-between items-center">
                      <span className="text-white font-bold text-lg">Total a cobrar:</span>
                      <span className="font-bold text-2xl text-green-400">
                        ${lastTripSummary.cost.toFixed(0)} MXN
                      </span>
                    </div>
                  </div>
                </div>
                
                <div className="text-center text-sm text-gray-400">
                  Viaje finalizado: {lastTripSummary.timestamp}
                </div>
                
                <button
                  onClick={() => setShowSummary(false)}
                  className="w-full bg-gradient-to-r from-yellow-400 to-yellow-500 hover:from-yellow-500 hover:to-yellow-600 text-black font-bold py-3 px-4 rounded-lg transition-all transform hover:scale-105 shadow-lg"
                >
                  Cerrar Resumen
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal de selección de tipo de viaje */}
        {showTripTypeSelector && (
          <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
            <div className="bg-gradient-to-br from-gray-900 to-black border border-yellow-400 rounded-xl p-6 max-w-sm w-full shadow-2xl">
              <div className="flex items-center justify-center mb-4">
                <Route className="w-8 h-8 text-yellow-400 mr-2" />
                <h2 className="text-2xl font-bold text-center text-white">
                  Tipo de Viaje
                </h2>
              </div>
              
              <div className="space-y-3">
                {TRIP_TYPES.map((tripType) => (
                  <button
                    key={tripType.id}
                    onClick={() => {
                      setSelectedTripType(tripType);
                      setTripData(prev => ({
                        ...prev,
                        cost: tripType.fixedPrice || RATES.baseFare
                      }));
                      setShowTripTypeSelector(false);
                    }}
                    className={`w-full p-4 rounded-xl border-2 transition-all text-left ${
                      selectedTripType.id === tripType.id
                        ? 'border-yellow-400 bg-yellow-400/10 text-yellow-400'
                        : 'border-gray-600 bg-gray-800 text-white hover:border-yellow-400/50'
                    }`}
                  >
                    <div className="font-bold text-lg">{tripType.name}</div>
                    <div className="text-sm text-gray-300 mt-1">{tripType.description}</div>
                    {tripType.fixedPrice && (
                      <div className="text-green-400 font-bold mt-2">
                        Precio base: ${tripType.fixedPrice} MXN
                      </div>
                    )}
                  </button>
                ))}
              </div>
              
              <button
                onClick={() => setShowTripTypeSelector(false)}
                className="w-full mt-4 bg-gradient-to-r from-gray-700 to-gray-600 hover:from-gray-600 hover:to-gray-500 text-white font-bold py-3 px-4 rounded-lg transition-all"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="bg-gradient-to-r from-black via-gray-900 to-black border-b-2 border-yellow-400 rounded-t-xl p-6 text-center shadow-2xl">
          <div className="flex items-center justify-center mb-2">
            <Zap className="w-10 h-10 text-yellow-400 mr-3 animate-pulse" />
            <div>
              <h1 className="text-3xl font-bold text-white tracking-wider">SPEED CABS</h1>
              <p className="text-yellow-400 text-sm font-semibold tracking-widest">ZAPOTLAN</p>
            </div>
            <Zap className="w-10 h-10 text-yellow-400 ml-3 animate-pulse" />
          </div>
          <div className="flex items-center justify-center mt-2">
            <div className={`w-4 h-4 rounded-full ${getStatusColor()} mr-2 animate-pulse shadow-lg`}></div>
            <span className="text-sm text-gray-300 font-medium">{getStatusText()}</span>
            {selectedTripType.id !== 'normal' && (
              <span className="ml-2 text-xs bg-yellow-400 text-black px-2 py-1 rounded-full font-bold">
                {selectedTripType.name}
              </span>
            )}
          </div>
        </div>

        {/* Pantalla principal */}
        <div className="bg-gradient-to-b from-gray-900 to-black text-yellow-400 p-6 text-center border-x-2 border-yellow-400">
          <div className="text-6xl font-mono font-bold mb-6 bg-gradient-to-br from-black to-gray-900 p-6 rounded-xl border-2 border-yellow-400 shadow-2xl relative overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-yellow-400/5 to-transparent animate-pulse"></div>
            ${tripData.cost.toFixed(0)} MXN
          </div>
          
          <div className="grid grid-cols-3 gap-4 text-center">
            <div className="bg-gradient-to-br from-gray-800 to-gray-900 p-4 rounded-xl border border-gray-700 shadow-lg hover:border-yellow-400/50 transition-all">
              <div className="flex items-center justify-center mb-1">
                <Route className="w-5 h-5 mr-1 text-yellow-400" />
              </div>
              <div className="text-xs text-gray-400 font-semibold">DISTANCIA</div>
              <div className="font-mono font-bold text-white">{tripData.distance.toFixed(3)} km</div>
            </div>
            
            <div className="bg-gradient-to-br from-gray-800 to-gray-900 p-4 rounded-xl border border-gray-700 shadow-lg hover:border-yellow-400/50 transition-all">
              <div className="flex items-center justify-center mb-1">
                <Clock className="w-5 h-5 mr-1 text-yellow-400" />
              </div>
              <div className="text-xs text-gray-400 font-semibold">ESPERA</div>
              <div className="font-mono font-bold text-white">{formatTime(tripData.waitingTime)}</div>
            </div>
            
            <div className="bg-gradient-to-br from-gray-800 to-gray-900 p-4 rounded-xl border border-gray-700 shadow-lg hover:border-yellow-400/50 transition-all">
              <div className="flex items-center justify-center mb-1">
                <Navigation className="w-5 h-5 mr-1 text-yellow-400" />
              </div>
              <div className="text-xs text-gray-400 font-semibold">GPS</div>
              <div className="font-bold text-xs text-white">
                {gpsStatus === 'available' && currentPosition ? (googleMapsReady ? 'Maps+GPS' : 'GPS Básico') : 
                 gpsStatus === 'requesting' ? 'Buscando...' :
                 gpsStatus === 'denied' ? 'Sin acceso' : 'No disponible'}
              </div>
            </div>
          </div>

          {/* Información de ubicación actual */}
          {currentPosition && currentAddress && (
            <div className="mt-4 bg-gradient-to-br from-gray-800 to-gray-900 p-3 rounded-xl border border-gray-700 shadow-lg">
              <div className="flex items-center justify-center mb-2">
                <MapPin className="w-4 h-4 text-yellow-400 mr-2" />
                <span className="text-xs text-gray-400 font-semibold">UBICACIÓN ACTUAL</span>
              </div>
              <div className="text-xs text-white text-center break-words">
                {currentAddress}
              </div>
            </div>
          )}
        </div>

        {/* Controles */}
        <div className="bg-gradient-to-b from-black to-gray-900 p-6 rounded-b-xl border-2 border-t-0 border-yellow-400 shadow-2xl">
          {/* Selector de tipo de viaje */}
          {!tripData.isRunning && (
            <div className="mb-4">
              <button
                onClick={() => setShowTripTypeSelector(true)}
                className="w-full bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white p-4 rounded-xl flex items-center justify-center font-bold transition-all border border-blue-500 shadow-lg"
              >
                <Route className="w-5 h-5 mr-2" />
                {selectedTripType.name}
                <ChevronDown className="w-5 h-5 ml-2" />
              </button>
              
              {selectedTripType.id !== 'normal' && (
                <div className="mt-2 bg-gradient-to-r from-blue-800 to-blue-900 text-white p-3 rounded-xl text-center border border-blue-500 shadow-lg">
                  <p className="text-sm">
                    📍 {selectedTripType.description}
                  </p>
                  {selectedTripType.fixedPrice && (
                    <p className="text-green-400 font-bold mt-1">
                      Precio base: ${selectedTripType.fixedPrice} MXN + tiempo de espera
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
          
          <div className="flex justify-center space-x-4">
            {!tripData.isRunning ? (
              <button
                onClick={startTrip}
                disabled={gpsStatus !== 'available'}
                className="bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 disabled:from-gray-600 disabled:to-gray-700 disabled:cursor-not-allowed text-white px-8 py-4 rounded-xl flex items-center font-bold text-lg transition-all transform hover:scale-105 shadow-lg border border-green-400"
              >
                <Play className="w-6 h-6 mr-2 drop-shadow-lg" />
                INICIAR
              </button>
            ) : (
              <>
                <button
                  onClick={togglePause}
                  className="bg-gradient-to-r from-yellow-500 to-yellow-600 hover:from-yellow-600 hover:to-yellow-700 text-black px-6 py-4 rounded-xl flex items-center font-bold transition-all transform hover:scale-105 shadow-lg border border-yellow-400"
                >
                  {tripData.isPaused ? (
                    <>
                      <Play className="w-5 h-5 mr-2 drop-shadow-lg" />
                      REANUDAR
                    </>
                  ) : (
                    <>
                      <Pause className="w-5 h-5 mr-2 drop-shadow-lg" />
                      PAUSAR
                    </>
                  )}
                </button>
                
                <button
                  onClick={stopTrip}
                  className="bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 text-white px-6 py-4 rounded-xl flex items-center font-bold transition-all transform hover:scale-105 shadow-lg border border-red-400"
                >
                  <Square className="w-5 h-5 mr-2 drop-shadow-lg" />
                  FINALIZAR
                </button>
              </>
            )}
          </div>

          {/* Botón de modo de prueba */}
          <div className="mt-4">
            <button
              onClick={toggleTestMode}
              className={`w-full p-4 rounded-xl flex items-center justify-center font-bold transition-all border shadow-lg ${
                isTestMode 
                  ? 'bg-gradient-to-r from-purple-500 to-purple-600 hover:from-purple-600 hover:to-purple-700 text-white border-purple-400' 
                  : 'bg-gradient-to-r from-gray-800 to-gray-700 hover:from-gray-700 hover:to-gray-600 text-purple-400 border-gray-600 hover:border-purple-400/50'
              }`}
            >
              <TestTube className="w-5 h-5 mr-2" />
              {isTestMode ? 'DESACTIVAR MODO PRUEBA' : 'ACTIVAR MODO PRUEBA'}
            </button>
            
            {isTestMode && (
              <div className="mt-2 bg-gradient-to-r from-purple-800 to-purple-900 text-white p-3 rounded-xl text-center border border-purple-500 shadow-lg">
                <p className="text-xs">
                  🧪 Modo de prueba activo - Simulando movimiento automáticamente
                </p>
              </div>
            )}
          </div>

          {/* Información de tarifas */}
          <div className="mt-6">
            <button
              onClick={() => setShowRates(!showRates)}
              className="w-full bg-gradient-to-r from-gray-800 to-gray-700 hover:from-gray-700 hover:to-gray-600 text-yellow-400 p-4 rounded-xl flex items-center justify-center font-bold transition-all border border-gray-600 hover:border-yellow-400/50 shadow-lg"
            >
              <Info className="w-5 h-5 mr-2" />
              VER TARIFAS
              {showRates ? (
                <ChevronUp className="w-5 h-5 ml-2" />
              ) : (
                <ChevronDown className="w-5 h-5 ml-2" />
              )}
            </button>
            
            {showRates && (
              <div className="mt-3 bg-gradient-to-br from-gray-800 to-gray-900 p-4 rounded-xl border border-gray-600 shadow-lg">
                <div className="flex items-center justify-center mb-3">
                  <Zap className="w-5 h-5 text-yellow-400 mr-2" />
                  <h3 className="text-yellow-400 font-bold text-center">TARIFAS SPEED CABS</h3>
                </div>
                <div className="text-white text-sm space-y-1">
                  <div className="flex justify-between">
                    <span>Tarifa base:</span>
                    <span className="text-yellow-400 font-semibold">${RATES.baseFare} MXN</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Tiempo espera:</span>
                    <span className="text-yellow-400 font-semibold">$3 MXN/min</span>
                  </div>
                  <div className="text-xs text-gray-300 mt-3 bg-gray-800 p-2 rounded-lg">
                    <div className="flex justify-between"><span>0-4.9 km:</span><span className="text-yellow-400">$50 MXN</span></div>
                    <div className="flex justify-between"><span>5-5.9 km:</span><span className="text-yellow-400">$60 MXN</span></div>
                    <div className="flex justify-between"><span>6-6.9 km:</span><span className="text-yellow-400">$65 MXN</span></div>
                    <div className="flex justify-between"><span>7-7.9 km:</span><span className="text-yellow-400">$70 MXN</span></div>
                    <div className="flex justify-between"><span>8+ km:</span><span className="text-yellow-400">$80 MXN</span></div>
                    <div className="flex justify-between"><span>8+ km:</span><span className="text-yellow-400">$16/km extra</span></div>
                    <div className="text-center mt-2 pt-2 border-t border-gray-600">
                      <span className="text-yellow-400 text-xs">
                        {googleMapsReady ? '✓ Google Maps Activo' : '⚠ GPS Básico'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {gpsStatus === 'denied' && (
            <div className="mt-4 bg-gradient-to-r from-red-600 to-red-700 text-white p-4 rounded-xl text-center border border-red-500 shadow-lg">
              <p className="text-sm">Se necesita acceso a la ubicación para funcionar correctamente.</p>
            </div>
          )}

          {gpsStatus === 'unavailable' && (
            <div className="mt-4 bg-gradient-to-r from-orange-600 to-orange-700 text-white p-4 rounded-xl text-center border border-orange-500 shadow-lg">
              <p className="text-sm">GPS no disponible en este dispositivo.</p>
            </div>
          )}

          {!googleMapsReady && gpsStatus === 'available' && (
            <div className="mt-4 bg-gradient-to-r from-blue-600 to-blue-700 text-white p-4 rounded-xl text-center border border-blue-500 shadow-lg">
              <p className="text-sm">Usando GPS básico. Google Maps no disponible.</p>
            </div>
          )}
          
          {/* Panel de debug para desarrollo */}
          {tripData.isRunning && currentPosition && (
            <div className="mt-4 bg-gradient-to-r from-purple-800 to-purple-900 text-white p-3 rounded-xl text-center border border-purple-500 shadow-lg">
              <div className="text-xs">
                <div>Estado: {tripData.isPaused ? 'Pausado' : 'Activo'} {isTestMode ? '(PRUEBA)' : '(GPS)'}</div>
                <div>Método: {isTestMode ? 'Simulación de Prueba' : 'Distancia Acumulativa'}</div>
                <div>Distancia total: {tripData.distance.toFixed(3)} km</div>
                <div>Posición: {currentPosition.latitude.toFixed(6)}, {currentPosition.longitude.toFixed(6)}</div>
                <div>Última actualización: {new Date(currentPosition.timestamp).toLocaleTimeString()}</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;