import { useState, useEffect, useRef } from 'react';
import { 
  UploadCloud, 
  CheckCircle2, 
  AlertTriangle, 
  XCircle, 
  FileText, 
  RefreshCw, 
  Image as ImageIcon, 
  Trash2,
  HelpCircle,
  Sparkles,
  Search,
  ScanEye
} from 'lucide-react';

interface CheckDetail {
  status: 'pass' | 'warning' | 'fail' | 'not_applicable';
  message: string;
  details?: any;
}

interface ImageResults {
  imageId: string;
  filename: string;
  originalName: string;
  mimeType: string;
  fileSizeBytes: number;
  width: number;
  height: number;
  imageType: string;
  overallStatus: 'usable' | 'review' | 'rejected';
  confidence: number;
  ocrText: string | null;
  checks: {
    blur: CheckDetail;
    brightness: CheckDetail;
    duplicate: CheckDetail;
    ocr: CheckDetail;
    numberPlate: CheckDetail;
    dimensions: CheckDetail;
    photoOfPhoto: CheckDetail;
    tampering: CheckDetail;
  };
  createdAt: string;
}

interface JobStatusResponse {
  processingId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  errorMessage?: string | null;
}

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [imageType, setImageType] = useState<string>('generic');
  const [isDragActive, setIsDragActive] = useState<boolean>(false);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [serverCheckState, setServerCheckState] = useState<'idle' | 'starting' | 'ready' | 'timeout'>('idle');
  const [startupElapsed, setStartupElapsed] = useState<number>(0);
  
  // Job Tracking
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<'pending' | 'processing' | 'completed' | 'failed' | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  
  // Final Results
  const [results, setResults] = useState<ImageResults | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const isSubmittingRef = useRef<boolean>(false);
  const activePollIdRef = useRef<string | null>(null);

  const getApiBase = () => {
    const value = import.meta.env.VITE_API_URL || '';
    return value.replace(/\/+$/, '');
  };

  const getApiUrl = (path: string) => {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const base = getApiBase();
    return base ? `${base}${normalizedPath}` : normalizedPath;
  };

  // Poll status when processingId is active (max ~90 seconds)
  useEffect(() => {
    if (!processingId) {
      activePollIdRef.current = null;
      return;
    }

    if (activePollIdRef.current === processingId) return;
    activePollIdRef.current = processingId;

    const POLL_TIMEOUT_MS = 90_000;
    const POLL_INTERVAL_MS = 1500;
    const startedAt = Date.now();
    let timer: number;
    let cancelled = false;

    const pollStatus = async () => {
      if (cancelled) return;

      // Check timeout before polling
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        setJobStatus('failed');
        setJobError(
          'Processing is taking longer than expected. Your image was uploaded successfully — please try again in a few moments.'
        );
        return;
      }

      try {
        const response = await fetch(getApiUrl(`/api/v1/images/${processingId}/status`));
        if (!response.ok) {
          throw new Error('Failed to fetch job status');
        }
        const data: JobStatusResponse = await response.json();
        setJobStatus(data.status);
        
        if (data.status === 'completed') {
          // Fetch final results
          fetchResults(processingId);
        } else if (data.status === 'failed') {
          setJobError(data.errorMessage || 'Job processing failed.');
        } else {
          // Poll again
          timer = window.setTimeout(pollStatus, POLL_INTERVAL_MS);
        }
      } catch (err: any) {
        // Network errors during polling are transient — retry up to the timeout
        if (Date.now() - startedAt < POLL_TIMEOUT_MS) {
          timer = window.setTimeout(pollStatus, POLL_INTERVAL_MS);
        } else {
          setError(err.message || 'Error tracking job status');
          setJobStatus('failed');
        }
      }
    };

    pollStatus();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (activePollIdRef.current === processingId) {
        activePollIdRef.current = null;
      }
    };
  }, [processingId]);

  const fetchResults = async (id: string) => {
    try {
      const response = await fetch(getApiUrl(`/api/v1/images/${id}/results`));
      if (!response.ok) {
        throw new Error('Failed to fetch image results');
      }
      const data = await response.json();
      setResults(data);
    } catch (err: any) {
      setError(err.message || 'Error loading validation results');
    }
  };

  const waitForBackendToWakeUp = async (): Promise<boolean> => {
    const baseUrl = getApiBase();
    if (!baseUrl) {
      setServerCheckState('timeout');
      setError('VITE_API_URL is not configured. Set the backend URL in Vercel environment variables.');
      return false;
    }

    const healthUrl = getApiUrl('/health');
    const startedAt = Date.now();
    setServerCheckState('starting');
    setStartupElapsed(0);

    const intervalId = window.setInterval(() => {
      setStartupElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    try {
      while (true) {
        try {
          const controller = new AbortController();
          const timeoutId = window.setTimeout(() => controller.abort(), 10000);
          const response = await fetch(healthUrl, {
            method: 'GET',
            signal: controller.signal,
            headers: {
              Accept: 'application/json',
            },
          });
          window.clearTimeout(timeoutId);

          if (response.ok) {
            setServerCheckState('ready');
            setStartupElapsed(0);
            return true;
          }
        } catch {
          // Ignore transient wake-up failures and continue polling.
        }

        const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
        setStartupElapsed(elapsedSeconds);

        if (elapsedSeconds >= 90) {
          setServerCheckState('timeout');
          setError('Verification server took too long to start. This can happen with free-tier hosting after inactivity. Please try again.');
          return false;
        }

        await new Promise((resolve) => window.setTimeout(resolve, 2000));
      }
    } finally {
      window.clearInterval(intervalId);
    }
  };

  const uploadImage = async (selectedFile: File, selectedImageType: string) => {
    const formData = new FormData();
    formData.append('image', selectedFile);
    formData.append('imageType', selectedImageType);

    try {
      setIsUploading(true);
      setError(null);
      setResults(null);
      setJobError(null);
      setJobStatus(null);
      setProcessingId(null);

      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 120000);

      const response = await fetch(getApiUrl('/api/v1/images'), {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      window.clearTimeout(timeoutId);

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to upload image');
      }

      const data = await response.json();
      setProcessingId(data.processingId);
      setJobStatus('pending');
      setServerCheckState('ready');
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        setError('Upload request timed out. The backend is slow or temporarily unavailable. Please try again.');
      } else {
        setError(err.message || 'Error occurred during image upload');
      }
    } finally {
      setIsUploading(false);
    }
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setIsDragActive(true);
    } else if (e.type === 'dragleave') {
      setIsDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const droppedFile = e.dataTransfer.files[0];
      if (validateFile(droppedFile)) {
        setFile(droppedFile);
      }
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selectedFile = e.target.files[0];
      if (validateFile(selectedFile)) {
        setFile(selectedFile);
      }
    }
  };

  const validateFile = (file: File): boolean => {
    setError(null);
    const validMimes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!validMimes.includes(file.type)) {
      setError('Unsupported file type. Please select JPEG, PNG, or WebP.');
      return false;
    }
    const maxBytes = 10 * 1024 * 1024; // 10MB
    if (file.size > maxBytes) {
      setError('File is too large. Max size is 10MB.');
      return false;
    }
    return true;
  };

  const triggerFileSelect = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || isSubmittingRef.current) return;

    isSubmittingRef.current = true;
    setError(null);
    setResults(null);
    setJobError(null);
    setJobStatus(null);
    setProcessingId(null);
    setIsUploading(true);

    const backendReady = await waitForBackendToWakeUp();
    if (!backendReady) {
      setIsUploading(false);
      isSubmittingRef.current = false;
      return;
    }

    try {
      await uploadImage(file, imageType);
    } finally {
      isSubmittingRef.current = false;
    }
  };

  const retryUpload = () => {
    if (!file) return;
    setError(null);
    setServerCheckState('idle');
    void handleUploadSubmit({ preventDefault: () => undefined } as React.FormEvent);
  };

  const resetForm = () => {
    setFile(null);
    setError(null);
    setProcessingId(null);
    setJobStatus(null);
    setJobError(null);
    setResults(null);
    setServerCheckState('idle');
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const renderStatusIcon = (status: CheckDetail['status']) => {
    switch (status) {
      case 'pass':
        return <CheckCircle2 className="check-icon pass" size={24} />;
      case 'warning':
        return <AlertTriangle className="check-icon warning" size={24} />;
      case 'fail':
        return <XCircle className="check-icon fail" size={24} />;
      case 'not_applicable':
      default:
        return <HelpCircle className="check-icon not_applicable" size={24} />;
    }
  };

  const getStatusClass = (status: CheckDetail['status']) => {
    switch (status) {
      case 'pass': return 'pass';
      case 'warning': return 'warning';
      case 'fail': return 'fail';
      case 'not_applicable':
      default:
        return 'not_applicable';
    }
  };

  const getDisplayedOcrText = (): string | null => {
    if (!results) return null;
    if (results.ocrText) return results.ocrText;
    const ocrTextFromCheck = (results.checks.ocr as any)?.text;
    return typeof ocrTextFromCheck === 'string' ? ocrTextFromCheck.trim() || null : null;
  };

  return (
    <div className="app-container">
      {/* Header Section */}
      <header className="header-section">
        <div className="badge-pill">
          <Sparkles size={14} /> AI-Powered Media Verification Pipeline
        </div>
        <h1 className="main-title">Evidence Guard</h1>
        <p className="sub-title">
          Verify digital campaign evidence in real time. Detect screen fraud, blur, tamper edits, duplicate reuse, and extract license plates instantly.
        </p>
      </header>

      {/* Main Grid */}
      <div className="dashboard-grid">
        {/* Left Control Panel */}
        <section className="glass-card">
          <h2 className="card-title">
            <ScanEye size={22} className="preview-icon" /> Upload Campaign Image
          </h2>
          
          <form onSubmit={handleUploadSubmit}>
            <div className="form-group">
              <label className="form-label" htmlFor="image-type-select">Campaign Image Context</label>
              <select 
                id="image-type-select"
                className="custom-select" 
                value={imageType}
                onChange={(e) => setImageType(e.target.value)}
                disabled={isUploading || !!processingId}
              >
                <option value="generic">Generic Campaign Image (Standard Checks)</option>
                <option value="vehicle">Vehicle / Delivery Transit (Plate Detection)</option>
                <option value="shop_branding">Shop / Retail Store Branding</option>
                <option value="banner">Hoarding / Billboard Campaign</option>
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">Evidence Image File</label>
              
              {!file ? (
                <div 
                  className={`drop-zone ${isDragActive ? 'active' : ''}`}
                  onDragEnter={handleDrag}
                  onDragOver={handleDrag}
                  onDragLeave={handleDrag}
                  onDrop={handleDrop}
                  onClick={triggerFileSelect}
                >
                  <input 
                    ref={fileInputRef}
                    type="file" 
                    style={{ display: 'none' }} 
                    onChange={handleFileChange}
                    accept="image/jpeg,image/png,image/webp"
                  />
                  <div className="upload-icon-wrapper">
                    <UploadCloud size={32} />
                  </div>
                  <div>
                    <p className="upload-text-main">Drag & drop your file here</p>
                    <p className="upload-text-sub">or click to browse local files</p>
                  </div>
                  <p className="upload-text-sub">JPEG, PNG, WebP up to 10MB</p>
                </div>
              ) : (
                <div className="file-preview">
                  <div className="preview-details">
                    <ImageIcon size={20} className="preview-icon" />
                    <div style={{ minWidth: 0 }}>
                      <p className="preview-name">{file.name}</p>
                      <p className="preview-size">{formatBytes(file.size)}</p>
                    </div>
                  </div>
                  <button 
                    type="button" 
                    className="btn-remove" 
                    onClick={resetForm}
                    disabled={isUploading || (jobStatus === 'pending' || jobStatus === 'processing')}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              )}
            </div>

            {(serverCheckState === 'starting' || serverCheckState === 'ready' || serverCheckState === 'timeout') && (
              <div style={{ marginBottom: '16px', padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--border-color)', background: serverCheckState === 'timeout' ? 'rgba(239,68,68,0.08)' : serverCheckState === 'ready' ? 'rgba(34,197,94,0.08)' : 'rgba(245,158,11,0.08)', color: serverCheckState === 'timeout' ? 'var(--accent-red)' : serverCheckState === 'ready' ? 'var(--accent-green)' : 'var(--accent-amber)' }}>
                {serverCheckState === 'starting' && (
                  <>
                    <div style={{ fontWeight: 600 }}>🟡 Starting verification server...</div>
                    <div style={{ marginTop: '4px', fontSize: '0.82rem' }}>This may take a little longer on the first request because the analysis server may need to wake up after inactivity.</div>
                    <div style={{ marginTop: '6px', fontSize: '0.8rem' }}>Server starting... {startupElapsed}s</div>
                  </>
                )}
                {serverCheckState === 'ready' && (
                  <div style={{ fontWeight: 600 }}>🟢 Server ready ✓</div>
                )}
                {serverCheckState === 'timeout' && (
                  <>
                    <div style={{ fontWeight: 600 }}>🔴 Verification server took too long to start.</div>
                    <div style={{ marginTop: '4px', fontSize: '0.82rem' }}>This can happen with free-tier hosting after inactivity. Please try again.</div>
                    <button
                      type="button"
                      onClick={retryUpload}
                      className="btn-primary"
                      style={{ marginTop: '10px', width: '100%' }}
                    >
                      Retry verification
                    </button>
                  </>
                )}
              </div>
            )}

            {error && (
              <div style={{ color: 'var(--accent-red)', fontSize: '0.85rem', marginBottom: '16px', display: 'flex', gap: '8px' }}>
                <XCircle size={16} style={{ flexShrink: 0 }} /> {error}
              </div>
            )}

            {!processingId && file && (
              <button 
                type="submit" 
                className="btn-primary"
                disabled={isUploading}
              >
                {isUploading ? (
                  <>
                    <RefreshCw className="spinner" size={20} style={{ animation: 'spin 1s linear infinite' }} />
                    {serverCheckState === 'starting' ? 'Starting verification server...' : 'Uploading...'}
                  </>
                ) : (
                  <>
                    <UploadCloud size={20} /> Verify Evidence Image
                  </>
                )}
              </button>
            )}
          </form>

          {/* Job Processing Tracker */}
          {processingId && jobStatus && (
            <div className="tracker-status">
              <div className="status-row">
                <span className="status-label">Pipeline Job ID:</span>
                <span className="status-value" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  {processingId.substring(0, 18)}...
                </span>
              </div>
              <div className="status-row">
                <span className="status-label">Queue Verification State:</span>
                <span className={`status-value ${jobStatus}`}>
                  {jobStatus === 'pending' && 'Queued (Pending)'}
                  {jobStatus === 'processing' && 'Analyzing Image...'}
                  {jobStatus === 'completed' && 'Analysis Completed'}
                  {jobStatus === 'failed' && 'Job Failed'}
                </span>
              </div>
              
              <div className="progress-container">
                <div 
                  className={`progress-fill ${jobStatus === 'processing' || jobStatus === 'pending' ? 'loading' : ''}`}
                  style={{ 
                    width: jobStatus === 'completed' ? '100%' : (jobStatus === 'failed' ? '100%' : '50%'),
                    backgroundColor: jobStatus === 'failed' ? 'var(--accent-red)' : undefined
                  }}
                />
              </div>

              {jobStatus === 'failed' && jobError && (
                <div style={{ color: 'var(--accent-red)', fontSize: '0.85rem', display: 'flex', gap: '8px', marginTop: '8px' }}>
                  <XCircle size={16} style={{ flexShrink: 0 }} /> {jobError}
                </div>
              )}

              {(jobStatus === 'completed' || jobStatus === 'failed') && (
                <button 
                  onClick={resetForm}
                  className="btn-primary"
                  style={{ marginTop: '16px', background: 'transparent', border: '1px solid var(--border-color)', boxShadow: 'none' }}
                >
                  Verify Another Image
                </button>
              )}
            </div>
          )}
        </section>

        {/* Right Dashboard Results View */}
        <section className="glass-card" style={{ minHeight: '400px' }}>
          {!results ? (
            <div className="placeholder-view">
              <Search size={48} />
              <div>
                <h3>No verification results loaded</h3>
                <p style={{ fontSize: '0.9rem', marginTop: '6px' }}>Upload an image on the left panel to begin verification checks.</p>
              </div>
            </div>
          ) : (
            <div>
              {/* Results Top Header */}
              <div className="results-header">
                <div className={`verdict-box ${results.overallStatus}`}>
                  {results.overallStatus === 'usable' && <CheckCircle2 size={20} />}
                  {results.overallStatus === 'review' && <AlertTriangle size={20} />}
                  {results.overallStatus === 'rejected' && <XCircle size={20} />}
                  Verdict: {results.overallStatus}
                </div>
                <div className="score-display">
                  <span className="score-label">Confidence Score:</span>
                  <span className="score-number">{(results.confidence * 100).toFixed(0)}%</span>
                </div>
              </div>

              {/* Metadata Items */}
              <div className="metadata-grid">
                <div className="metadata-item">
                  <p className="metadata-label">File Type</p>
                  <p className="metadata-value">{results.mimeType.split('/')[1].toUpperCase()}</p>
                </div>
                <div className="metadata-item">
                  <p className="metadata-label">File Size</p>
                  <p className="metadata-value">{formatBytes(results.fileSizeBytes)}</p>
                </div>
                <div className="metadata-item">
                  <p className="metadata-label">Dimensions</p>
                  <p className="metadata-value">{results.width} x {results.height}px</p>
                </div>
                <div className="metadata-item">
                  <p className="metadata-label">Campaign Type</p>
                  <p className="metadata-value" style={{ textTransform: 'capitalize' }}>{results.imageType}</p>
                </div>
              </div>

              {/* Checks list */}
              <h3 className="checks-section-title">Automated Verification Checks</h3>
              <div className="checks-list">
                {/* Blur */}
                <div className="check-card">
                  <div className="check-info">
                    {renderStatusIcon(results.checks.blur.status)}
                    <div className="check-name-desc">
                      <span className="check-name">Motion / Focus Blur</span>
                      <span className="check-desc">{results.checks.blur.message}</span>
                    </div>
                  </div>
                  <span className={`check-status-badge ${getStatusClass(results.checks.blur.status)}`}>
                    {results.checks.blur.status === 'not_applicable' ? 'N/A' : results.checks.blur.status}
                  </span>
                </div>

                {/* Brightness */}
                <div className="check-card">
                  <div className="check-info">
                    {renderStatusIcon(results.checks.brightness.status)}
                    <div className="check-name-desc">
                      <span className="check-name">Lighting & Exposure</span>
                      <span className="check-desc">{results.checks.brightness.message}</span>
                    </div>
                  </div>
                  <span className={`check-status-badge ${getStatusClass(results.checks.brightness.status)}`}>
                    {results.checks.brightness.status === 'not_applicable' ? 'N/A' : results.checks.brightness.status}
                  </span>
                </div>

                {/* Duplicate */}
                <div className="check-card">
                  <div className="check-info">
                    {renderStatusIcon(results.checks.duplicate.status)}
                    <div className="check-name-desc">
                      <span className="check-name">Duplicate Detection (Image Reuse)</span>
                      <span className="check-desc">{results.checks.duplicate.message}</span>
                    </div>
                  </div>
                  <span className={`check-status-badge ${getStatusClass(results.checks.duplicate.status)}`}>
                    {results.checks.duplicate.status === 'not_applicable' ? 'N/A' : results.checks.duplicate.status}
                  </span>
                </div>

                {/* Tampering */}
                <div className="check-card">
                  <div className="check-info">
                    {renderStatusIcon(results.checks.tampering.status)}
                    <div className="check-name-desc">
                      <span className="check-name">Metadata & Error Level Tampering</span>
                      <span className="check-desc">{results.checks.tampering.message}</span>
                    </div>
                  </div>
                  <span className={`check-status-badge ${getStatusClass(results.checks.tampering.status)}`}>
                    {results.checks.tampering.status === 'not_applicable' ? 'N/A' : results.checks.tampering.status}
                  </span>
                </div>

                {/* Photo-of-photo */}
                <div className="check-card">
                  <div className="check-info">
                    {renderStatusIcon(results.checks.photoOfPhoto.status)}
                    <div className="check-name-desc">
                      <span className="check-name">Screen Display Fraud (Screenshot/Moiré)</span>
                      <span className="check-desc">{results.checks.photoOfPhoto.message}</span>
                    </div>
                  </div>
                  <span className={`check-status-badge ${getStatusClass(results.checks.photoOfPhoto.status)}`}>
                    {results.checks.photoOfPhoto.status === 'not_applicable' ? 'N/A' : results.checks.photoOfPhoto.status}
                  </span>
                </div>

                {/* Dimensions */}
                <div className="check-card">
                  <div className="check-info">
                    {renderStatusIcon(results.checks.dimensions.status)}
                    <div className="check-name-desc">
                      <span className="check-name">Quality & Resolution</span>
                      <span className="check-desc">{results.checks.dimensions.message}</span>
                    </div>
                  </div>
                  <span className={`check-status-badge ${getStatusClass(results.checks.dimensions.status)}`}>
                    {results.checks.dimensions.status === 'not_applicable' ? 'N/A' : results.checks.dimensions.status}
                  </span>
                </div>

                {/* License Plate (Specialized) */}
                <div className="check-card">
                  <div className="check-info">
                    {renderStatusIcon(results.checks.numberPlate.status)}
                    <div className="check-name-desc">
                      <span className="check-name">Indian License Plate Validation</span>
                      <span className="check-desc">
                        {results.checks.numberPlate.status === 'not_applicable'
                          ? results.imageType === 'vehicle'
                            ? 'No plate found in image.'
                            : 'Select "Vehicle" type to enable plate detection.'
                          : results.checks.numberPlate.message}
                      </span>
                      {/* Show the detected plate number as a highlight */}
                      {(results.checks.numberPlate as any).normalized && (
                        <span style={{
                          display: 'inline-block',
                          marginTop: '6px',
                          fontFamily: 'var(--font-mono)',
                          fontWeight: 700,
                          fontSize: '1rem',
                          letterSpacing: '0.12em',
                          color: results.checks.numberPlate.status === 'pass' ? 'var(--accent-green)' : 'var(--accent-amber)',
                          background: results.checks.numberPlate.status === 'pass'
                            ? 'rgba(16,185,129,0.08)' : 'rgba(245,158,11,0.08)',
                          border: `1px solid ${results.checks.numberPlate.status === 'pass' ? 'rgba(16,185,129,0.25)' : 'rgba(245,158,11,0.25)'}`,
                          borderRadius: '6px',
                          padding: '2px 10px',
                        }}>
                          {(results.checks.numberPlate as any).normalized}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className={`check-status-badge ${getStatusClass(results.checks.numberPlate.status)}`}>
                    {results.checks.numberPlate.status === 'not_applicable' ? 'N/A' : results.checks.numberPlate.status}
                  </span>
                </div>
              </div>

              {/* OCR text display */}
              <div className="ocr-card">
                <h4 className="ocr-title">
                  <FileText size={18} /> Extracted Image Text (OCR)
                </h4>
                {getDisplayedOcrText() ? (
                  <div className="ocr-text-box">{getDisplayedOcrText()}</div>
                ) : (
                  <p className="ocr-empty">No text detected in the image.</p>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default App;
